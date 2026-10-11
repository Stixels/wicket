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
  private team?: Promise<{ id: string; stateId?: string; stateName: string; labels: Map<string, string> }>;

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
