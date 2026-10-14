import type { TicketDraft, TicketKind, Tracker } from "../types.js";

export interface GitHubIssuesOptions {
  token: string; // fine-grained token with Issues: read and write on the repo
  repo: string; // "owner/repo"
  /** Label names per kind; labels the repo doesn't have are skipped. */
  labels?: Partial<Record<TicketKind, string>>;
  /** Extra label on every ticket if it exists, e.g. "triage". */
  sourceLabel?: string;
  apiUrl?: string; // GitHub Enterprise: https://HOST/api/v3
}

// GitHub's default labels
const DEFAULT_LABELS: Record<TicketKind, string> = { bug: "bug", feature: "enhancement", improvement: "enhancement", docs: "documentation", question: "question" };

/** Files tickets as GitHub issues, with the repo's matching labels. */
export class GitHubIssuesTracker implements Tracker {
  name = "github";
  private labels?: Promise<Map<string, string>>;

  constructor(private opts: GitHubIssuesOptions) {}

  async create(ticket: TicketDraft) {
    const existing = await (this.labels ??= this.loadLabels());
    const names = [this.opts.labels?.[ticket.kind] ?? DEFAULT_LABELS[ticket.kind], this.opts.sourceLabel];
    const labels = names.map((n) => n && existing.get(n.toLowerCase())).filter((n): n is string => Boolean(n));
    const issue = await this.api<{ number: number; html_url: string }>("POST", "/issues", { title: ticket.title, body: ticket.description, labels });
    return { key: `#${issue.number}`, url: issue.html_url };
  }

  /** Checks the token and repo, and says where tickets will land. */
  async check(): Promise<string> {
    const repo = await this.api<{ full_name: string; has_issues: boolean }>("GET", "");
    if (!repo.has_issues) throw new Error(`GitHub: issues are turned off in ${repo.full_name}`);
    const labels = await (this.labels ??= this.loadLabels());
    const missing = this.opts.sourceLabel && !labels.has(this.opts.sourceLabel.toLowerCase()) ? `, label "${this.opts.sourceLabel}" not found` : "";
    return `new tickets go to ${repo.full_name}${missing}`;
  }

  private async loadLabels() {
    const labels = new Map<string, string>();
    for (let page = 1; page <= 5; page++) {
      const batch = await this.api<{ name: string }[]>("GET", `/labels?per_page=100&page=${page}`);
      for (const l of batch) labels.set(l.name.toLowerCase(), l.name);
      if (batch.length < 100) break;
    }
    return labels;
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.opts.apiUrl ?? "https://api.github.com"}/repos/${this.opts.repo}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.opts.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) {
      this.labels = undefined; // retry next time, e.g. after the token is fixed
      throw new Error(`GitHub: ${data.message ?? res.status}`);
    }
    return data;
  }
}
