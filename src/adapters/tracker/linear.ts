import type { TicketDraft, TicketKind, Tracker } from "../types.js";

export interface LinearOptions {
  apiKey: string; // a personal API key (Settings > Security & access)
  teamKey: string; // e.g. "ED"
  /** Label names per kind; labels the workspace doesn't have are skipped. */
  labels?: Partial<Record<TicketKind, string>>;
  /** Extra label on every ticket if it exists, e.g. "Source: Discord". */
  sourceLabel?: string;
}

const DEFAULT_LABELS: Record<TicketKind, string> = { bug: "Bug", feature: "Feature", improvement: "Improvement", docs: "Docs", question: "Question" };

/** Files tickets in Linear: in Triage when the team has it turned on, otherwise in Backlog. */
export class LinearTracker implements Tracker {
  name = "linear";
  private team?: Promise<{ id: string; stateId?: string; labels: Map<string, string> }>;

  constructor(private opts: LinearOptions) {}

  async create(ticket: TicketDraft) {
    const team = await (this.team ??= this.loadTeam());
    const names = [this.opts.labels?.[ticket.kind] ?? DEFAULT_LABELS[ticket.kind], this.opts.sourceLabel];
    const labelIds = names.map((n) => n && team.labels.get(n.toLowerCase())).filter((id): id is string => Boolean(id));
    const data = await this.gql<{ issueCreate: { success: boolean; issue: { identifier: string; url: string } } }>(
      `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }`,
      { input: { teamId: team.id, title: ticket.title, description: ticket.description, labelIds, ...(team.stateId ? { stateId: team.stateId } : {}) } },
    );
    if (!data.issueCreate.success) throw new Error("Linear didn't create the issue");
    return { key: data.issueCreate.issue.identifier, url: data.issueCreate.issue.url };
  }

  private async loadTeam() {
    const data = await this.gql<{
      teams: { nodes: { id: string; states: { nodes: { id: string; type: string; position: number }[] }; labels: { nodes: { id: string; name: string }[] } }[] };
      issueLabels: { nodes: { id: string; name: string; team: { id: string } | null }[] };
    }>(
      `query($key: String!) {
        teams(filter: { key: { eq: $key } }) { nodes { id states { nodes { id type position } } labels(first: 250) { nodes { id name } } } }
        issueLabels(first: 250, filter: { team: { null: true } }) { nodes { id name team { id } } }
      }`,
      { key: this.opts.teamKey },
    );
    const team = data.teams.nodes[0];
    if (!team) {
      this.team = undefined; // retry next time, e.g. after the key is fixed
      throw new Error(`Linear team ${this.opts.teamKey} not found`);
    }
    const byType = (t: string) => team.states.nodes.filter((s) => s.type === t).sort((a, b) => a.position - b.position)[0];
    const labels = new Map<string, string>();
    for (const l of [...data.issueLabels.nodes, ...team.labels.nodes]) labels.set(l.name.toLowerCase(), l.id); // team labels win
    return { id: team.id, stateId: (byType("triage") ?? byType("backlog"))?.id, labels };
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
