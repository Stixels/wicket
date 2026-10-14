import type { TicketDraft, TicketKind, TrackedTicket, Tracker } from "../types.js";

export interface LinearOptions {
  apiKey: string; // a personal API key (Settings > Security & access)
  teamKey: string; // e.g. "ED"
  /** Label names per kind; labels the workspace doesn't have are skipped. */
  labels?: Partial<Record<TicketKind, string>>;
  /** Extra label on every ticket if it exists, e.g. "Source: Discord". */
  sourceLabel?: string;
}

const DEFAULT_LABELS: Record<TicketKind, string> = { bug: "Bug", feature: "Feature", improvement: "Improvement", docs: "Docs", question: "Question" };

const FIELDS = "id identifier url title state { type }";
interface IssueNode {
  id: string;
  identifier: string;
  url: string;
  title: string;
  state: { type: string };
}

/** Files tickets in Linear: in Triage when the team has it turned on, otherwise in Backlog. */
export class LinearTracker implements Tracker {
  name = "linear";
  private team?: Promise<{ id: string; stateId?: string; stateName: string; labels: Map<string, string> }>;

  constructor(private opts: LinearOptions) {}

  async create(ticket: TicketDraft) {
    const team = await (this.team ??= this.loadTeam());
    const names = [this.opts.labels?.[ticket.kind] ?? DEFAULT_LABELS[ticket.kind], this.opts.sourceLabel];
    const labelIds = names.map((n) => n && team.labels.get(n.toLowerCase())).filter((id): id is string => Boolean(id));
    const data = await this.gql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } } }>(
      `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`,
      { input: { teamId: team.id, title: ticket.title, description: ticket.description, labelIds, ...(team.stateId ? { stateId: team.stateId } : {}) } },
    );
    if (!data.issueCreate.success) throw new Error("Linear didn't create the issue");
    const issue = data.issueCreate.issue;
    return { id: issue.id, key: issue.identifier, url: issue.url };
  }

  /** Open issues in the team that match, by Linear's own search. */
  async search(text: string, limit: number): Promise<TrackedTicket[]> {
    const team = await (this.team ??= this.loadTeam());
    const data = await this.gql<{ searchIssues: { nodes: IssueNode[] } }>(
      `query($term: String!, $first: Int!, $teamId: String!, $filter: IssueFilter) { searchIssues(term: $term, first: $first, teamId: $teamId, filter: $filter) { nodes { ${FIELDS} } } }`,
      {
        term: text.slice(0, 200),
        first: limit,
        teamId: team.id,
        filter: { team: { id: { eq: team.id } }, state: { type: { nin: ["completed", "canceled"] } } },
      },
    );
    return data.searchIssues.nodes.map(toTicket);
  }

  /** An issue by identifier ("ED-123") or its Linear link. */
  async get(keyOrUrl: string): Promise<TrackedTicket | null> {
    const key = /\/issue\/([A-Za-z0-9]+-\d+)/.exec(keyOrUrl)?.[1] ?? keyOrUrl.trim();
    if (!/^[A-Za-z0-9]+-\d+$/.test(key)) return null;
    try {
      const data = await this.gql<{ issue: IssueNode }>(`query($id: String!) { issue(id: $id) { ${FIELDS} } }`, { id: key.toUpperCase() });
      return toTicket(data.issue);
    } catch (err) {
      if (/not found|entity/i.test(String((err as Error).message))) return null;
      throw err;
    }
  }

  async comment(id: string, body: string): Promise<void> {
    const data = await this.gql<{ commentCreate: { success: boolean } }>(
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId: id, body } },
    );
    if (!data.commentCreate.success) throw new Error("Linear didn't add the comment");
  }

  async states(ids: string[]): Promise<TrackedTicket[]> {
    const out: TrackedTicket[] = [];
    // Small pages, and relations only for canceled issues: Linear rejects queries it finds too complex.
    for (let i = 0; i < ids.length; i += 50) {
      const page = ids.slice(i, i + 50);
      const data = await this.gql<{ issues: { nodes: IssueNode[] } }>(
        `query($ids: [ID!], $first: Int!) { issues(first: $first, filter: { id: { in: $ids } }) { nodes { ${FIELDS} } } }`,
        { ids: page, first: page.length },
      );
      for (const node of data.issues.nodes) {
        const ticket = toTicket(node);
        if (node.state.type === "canceled") ticket.duplicateOf = await this.duplicateOf(node.id);
        out.push(ticket);
      }
    }
    return out;
  }

  /** The issue a canceled issue was marked a duplicate of, if any. */
  private async duplicateOf(id: string): Promise<TrackedTicket | undefined> {
    const data = await this.gql<{ issue: { relations: { nodes: { type: string; relatedIssue: IssueNode }[] } } }>(
      `query($id: String!) { issue(id: $id) { relations(first: 10) { nodes { type relatedIssue { ${FIELDS} } } } } }`,
      { id },
    );
    const rel = data.issue.relations.nodes.find((r) => r.type === "duplicate");
    return rel ? toTicket(rel.relatedIssue) : undefined;
  }

  /** Checks the key and team, and says where tickets will land. */
  async check(): Promise<string> {
    const team = await (this.team ??= this.loadTeam());
    return `team ${this.opts.teamKey}, new tickets go to ${team.stateName}`;
  }

  private async loadTeam() {
    // Separate small queries: Linear rejects one big nested query as too complex.
    const data = await this.gql<{
      teams: { nodes: { id: string; states: { nodes: { id: string; name: string; type: string; position: number }[] } }[] };
    }>(`query($key: String!) { teams(first: 1, filter: { key: { eq: $key } }) { nodes { id states(first: 50) { nodes { id name type position } } } } }`, {
      key: this.opts.teamKey,
    });
    const found = data.teams.nodes[0];
    const labelData = found
      ? await this.gql<{ team: { labels: { nodes: { id: string; name: string }[] } }; issueLabels: { nodes: { id: string; name: string }[] } }>(
          `query($id: String!) { team(id: $id) { labels(first: 100) { nodes { id name } } } issueLabels(first: 100, filter: { team: { null: true } }) { nodes { id name } } }`,
          { id: found.id },
        )
      : null;
    const team = found;
    if (!team) {
      this.team = undefined; // retry next time, e.g. after the key is fixed
      throw new Error(`Linear team ${this.opts.teamKey} not found`);
    }
    const byType = (t: string) => team.states.nodes.filter((s) => s.type === t).sort((a, b) => a.position - b.position)[0];
    const labels = new Map<string, string>();
    for (const l of [...labelData!.issueLabels.nodes, ...labelData!.team.labels.nodes]) labels.set(l.name.toLowerCase(), l.id); // team labels win
    const state = byType("triage") ?? byType("backlog");
    return { id: team.id, stateId: state?.id, stateName: state?.name ?? "the default status", labels };
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: this.opts.apiKey },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
    if (!res.ok || body.errors?.length || !body.data) {
      if (this.team) this.team = undefined;
      throw new Error(`Linear: ${body.errors?.map((e) => e.message).join("; ") || res.status}`);
    }
    return body.data;
  }
}

function toTicket(n: IssueNode): TrackedTicket {
  const state = n.state.type === "completed" ? "done" : n.state.type === "canceled" ? "closed" : "open";
  return { id: n.id, key: n.identifier, url: n.url, title: n.title, state };
}
