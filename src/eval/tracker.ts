import type { TicketDraft, TicketKind, TrackedTicket, Tracker } from "../adapters/types.js";

/** An existing ticket the eval's backlog starts with. */
export interface BacklogTicket {
  key: string;
  title: string;
  kind: TicketKind;
  description?: string;
}

/** What the assistant did to the backlog during one case. */
export interface TrackerLog {
  filed: { key: string; title: string; kind: TicketKind; description: string }[];
  /** Keys the assistant added a report to, once per comment. */
  added: string[];
}

const STOP = new Set("the and for with that this from when have has are was were not but you your our its it's they them their there then than into onto just also every after before about".split(" "));
const words = (text: string) => (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w));

/**
 * An in-memory tracker for the eval: starts from a backlog, searches it roughly the way a real
 * tracker's search would (shared words in title and description), and records what the assistant
 * filed and added to. Nothing leaves the machine.
 */
export class EvalTracker implements Tracker {
  name = "eval";
  private tickets: (TrackedTicket & { kind: TicketKind; description: string; comments: string[] })[] = [];
  private next: number;
  readonly log: TrackerLog = { filed: [], added: [] };

  constructor(backlog: BacklogTicket[]) {
    for (const t of backlog) this.tickets.push({ id: t.key, key: t.key, url: `https://tracker.test/${t.key}`, title: t.title, kind: t.kind, description: t.description ?? "", state: "open", comments: [] });
    this.next = 1 + Math.max(900, ...backlog.map((t) => Number(/\d+$/.exec(t.key)?.[0] ?? 0)));
  }

  async create(t: TicketDraft) {
    const key = `ED-${this.next++}`;
    this.tickets.push({ id: key, key, url: `https://tracker.test/${key}`, title: t.title, kind: t.kind, description: t.description, state: "open", comments: [] });
    this.log.filed.push({ key, title: t.title, kind: t.kind, description: t.description });
    return { id: key, key, url: `https://tracker.test/${key}` };
  }

  async search(text: string, limit: number) {
    const want = new Set(words(text));
    return this.tickets
      .map((t) => ({ t, score: new Set(words(`${t.title} ${t.description}`).filter((w) => want.has(w))).size }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => plain(x.t));
  }

  async get(keyOrUrl: string) {
    const k = keyOrUrl.trim().toLowerCase();
    const t = this.tickets.find((x) => x.key.toLowerCase() === k || x.url === keyOrUrl.trim());
    return t ? plain(t) : null;
  }

  async comment(id: string, body: string) {
    const t = this.tickets.find((x) => x.id === id);
    if (!t) throw new Error(`no ticket ${id}`);
    t.comments.push(body);
    this.log.added.push(t.key);
  }

  async states(ids: string[]) {
    return this.tickets.filter((t) => ids.includes(t.id)).map(plain);
  }
}

const plain = (t: TrackedTicket): TrackedTicket => ({ id: t.id, key: t.key, url: t.url, title: t.title, state: t.state });
