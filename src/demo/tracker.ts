import type { Db } from "../db/index.js";
import type { TicketDraft, TicketKind, TrackedTicket, Tracker } from "../adapters/types.js";
import { isIdea } from "../tickets.js";

/** A ticket the demo starts with, so a repeat report has something to join. */
export interface DemoBacklogTicket {
  key: string;
  kind: TicketKind;
  title: string;
}

export interface DemoTrackerOptions {
  /** How long after its last report a ticket moves on: bugs and docs to done, ideas to planned. */
  advanceMs: number;
  backlog?: DemoBacklogTicket[];
  now?: () => number;
}

interface Row {
  key: string;
  kind: TicketKind;
  title: string;
  backlog: number;
  /** The last report on it (filed, or a repeat report). Null for a backlog ticket nobody has reported yet. */
  touched_at: number | null;
}

const STOP = new Set("the and for with that this from when have has are was were not but you your our its it's they them their there then than into onto just also every after before about".split(" "));
const words = (text: string) => (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w));

/**
 * The public demo's tracker. Tickets live in the service's own SQLite and never leave it. Each one
 * moves on a few minutes after its last report (bugs to fixed, ideas to planned), standing in for a
 * team working through them, so a visitor sees the hear-back loop.
 *
 * Search only covers the backlog from the settings: one visitor's ticket titles never show up in
 * another visitor's chat.
 */
export class DemoTracker implements Tracker {
  name = "demo";
  private now: () => number;

  constructor(
    private db: Db,
    private opts: DemoTrackerOptions,
  ) {
    this.now = opts.now ?? Date.now;
    const sql = db.$client;
    sql.exec(`CREATE TABLE IF NOT EXISTS demo_tickets (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      backlog INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      touched_at INTEGER
    )`);
    const seed = sql.prepare(`INSERT INTO demo_tickets (key, kind, title, backlog, created_at) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, title = excluded.title, backlog = 1`);
    for (const t of opts.backlog ?? []) seed.run(t.key, t.kind, t.title, this.now());
  }

  async check() {
    return "demo tickets in this service's database";
  }

  async create(t: TicketDraft) {
    const sql = this.db.$client;
    const next = (sql.prepare(`SELECT count(*) AS n FROM demo_tickets WHERE backlog = 0`).get() as { n: number }).n + 1001;
    const key = `DEMO-${next}`;
    const now = this.now();
    sql.prepare(`INSERT INTO demo_tickets (key, kind, title, created_at, touched_at) VALUES (?, ?, ?, ?, ?)`).run(key, t.kind, t.title.slice(0, 200), now, now);
    return { id: key, key, url: ticketUrl(key) };
  }

  async search(text: string, limit: number) {
    const want = new Set(words(text));
    const rows = this.db.$client.prepare(`SELECT * FROM demo_tickets WHERE backlog = 1`).all() as Row[];
    return rows
      .map((r) => ({ r, score: new Set(words(r.title).filter((w) => want.has(w))).size }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => this.tracked(x.r))
      .filter((t) => t.state === "open");
  }

  async get(keyOrUrl: string) {
    const k = keyOrUrl.trim().replace(/^.*#/, "").toUpperCase();
    const row = this.db.$client.prepare(`SELECT * FROM demo_tickets WHERE upper(key) = ?`).get(k) as Row | undefined;
    return row ? this.tracked(row) : null;
  }

  /** A repeat report restarts the clock, so this reporter hears back a few minutes from now too. */
  async comment(id: string) {
    const changed = this.db.$client.prepare(`UPDATE demo_tickets SET touched_at = ? WHERE key = ?`).run(this.now(), id).changes;
    if (!changed) throw new Error(`no ticket ${id}`);
  }

  async states(ids: string[]) {
    if (!ids.length) return [];
    const rows = this.db.$client.prepare(`SELECT * FROM demo_tickets WHERE key IN (${ids.map(() => "?").join(",")})`).all(...ids) as Row[];
    return rows.map((r) => this.tracked(r));
  }

  private tracked(r: Row): TrackedTicket {
    const moved = r.touched_at !== null && this.now() - r.touched_at >= this.opts.advanceMs;
    const idea = isIdea(r.kind);
    return {
      id: r.key,
      key: r.key,
      url: ticketUrl(r.key),
      title: r.title,
      state: moved && !idea ? "done" : "open",
      ...(moved && idea ? { planned: true } : {}),
    };
  }
}

/** Demo tickets have no page of their own; the link names the key on the demo page. */
const ticketUrl = (key: string) => `/demo#${key}`;
