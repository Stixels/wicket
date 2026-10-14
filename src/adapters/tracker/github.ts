import type { TicketDraft, TicketKind, TrackedTicket, Tracker } from "../types.js";
import { replyFrom } from "./linear.js";

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
    return { id: String(issue.number), key: `#${issue.number}`, url: issue.html_url };
  }

  /** Open issues that match, by GitHub's issue search. */
  async search(text: string, limit: number): Promise<TrackedTicket[]> {
    const words = text.replace(/["\\:]/g, " ").trim().slice(0, 200);
    const q = encodeURIComponent(`repo:${this.opts.repo} is:issue is:open ${words}`);
    const data = await this.api<{ items: Issue[] }>("GET", `/search/issues?q=${q}&per_page=${limit}`, undefined, true);
    return data.items.map(toTicket);
  }

  /** An issue by "#12", "12" or its link. */
  async get(keyOrUrl: string): Promise<TrackedTicket | null> {
    const n = /\/issues\/(\d+)/.exec(keyOrUrl)?.[1] ?? /^#?(\d+)$/.exec(keyOrUrl.trim())?.[1];
    if (!n) return null;
    try {
      const issue = await this.api<Issue>("GET", `/issues/${n}`);
      return issue.pull_request ? null : toTicket(issue);
    } catch (err) {
      if (/not found/i.test(String((err as Error).message))) return null;
      throw err;
    }
  }

  async comment(id: string, body: string): Promise<void> {
    await this.api("POST", `/issues/${id.replace(/^#/, "")}/comments`, { body });
  }

  /** GitHub has no batch lookup, so one call per issue; closed-not-completed ones also read comments for a "Reply:". */
  async states(ids: string[]): Promise<TrackedTicket[]> {
    const out: TrackedTicket[] = [];
    for (const id of ids) {
      const n = id.replace(/^#/, "");
      const issue = await this.api<Issue>("GET", `/issues/${n}`).catch((err) => {
        if (/not found|gone/i.test(String(err.message))) return null;
        throw err;
      });
      if (!issue) continue;
      const ticket = { ...toTicket(issue), id };
      if (ticket.state === "closed") {
        const comments = await this.api<{ body: string; created_at: string }[]>("GET", `/issues/${n}/comments?per_page=100`);
        ticket.reason = replyFrom(comments.map((c) => ({ body: c.body ?? "", createdAt: c.created_at })));
      }
      out.push(ticket);
    }
    return out;
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

  /** `path` is under the repo unless `root` is set. */
  private async api<T>(method: string, path: string, body?: unknown, root = false): Promise<T> {
    const res = await fetch(`${this.opts.apiUrl ?? "https://api.github.com"}${root ? "" : `/repos/${this.opts.repo}`}${path}`, {
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

interface Issue {
  number: number;
  html_url: string;
  title: string;
  state: "open" | "closed";
  state_reason?: string | null;
  pull_request?: unknown;
}

/** Closed as completed is done; closed as not planned or duplicate is closed. GitHub has no "planned". */
function toTicket(i: Issue): TrackedTicket {
  const state = i.state === "open" ? "open" : i.state_reason === "completed" || !i.state_reason ? "done" : "closed";
  return { id: String(i.number), key: `#${i.number}`, url: i.html_url, title: i.title, state };
}
