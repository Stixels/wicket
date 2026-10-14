import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Db } from "./db/index.js";
import type { TicketDraft, TicketKind, TrackedTicket, Tracker } from "./adapters/types.js";

/** A ticket someone reported is done; tell them in their conversation. */
export interface ShippedNotice {
  conversationId: string;
  key: string;
  title: string;
  kind: TicketKind | null;
  /** The reporter's own words for it, when the assistant wrote them down. */
  summary: string | null;
  /** When they reported it. */
  reportedAt: number;
}

export interface DeskTicket extends TrackedTicket {
  /** How many conversations are linked to it. */
  reports: number;
}

/** A conversation's tickets, for the team. */
export interface LinkedTicket {
  key: string;
  url: string;
  title: string;
  state: "open" | "done" | "closed";
  relation: "filed" | "added";
  notified: boolean;
}

export interface DeskOptions {
  /** Delivers a "shipped" notice. Throwing leaves it to be retried on the next check. */
  notify: (notice: ShippedNotice) => Promise<void>;
  log?: (msg: string, err?: unknown) => void;
}

type Row = typeof schema.tickets.$inferSelect;

/**
 * Files tickets, folds repeat reports into the ticket that already exists, and remembers
 * which conversations each ticket came from. `check()` asks the tracker what's done and
 * tells everyone who reported it.
 */
export class TicketDesk {
  private log: (msg: string, err?: unknown) => void;

  constructor(
    private db: Db,
    readonly tracker: Tracker,
    private opts: DeskOptions,
  ) {
    this.log = opts.log ?? console.log;
  }

  /** True when the tracker can say what's done, so reporters will hear back. */
  get canFollow(): boolean {
    return Boolean(this.tracker.states);
  }

  /** Open tickets that might already cover this, best first, with how many people reported each. */
  async find(text: string, limit = 5): Promise<DeskTicket[]> {
    const found = this.tracker.search ? await this.tracker.search(text, limit) : this.searchLocal(text, limit);
    const ids = found.map((t) => this.idFor(t.id));
    const counts = new Map(
      ids.length
        ? this.db
            .select({ id: schema.ticketLinks.ticketId, n: sql<number>`count(*)` })
            .from(schema.ticketLinks)
            .where(inArray(schema.ticketLinks.ticketId, ids))
            .groupBy(schema.ticketLinks.ticketId)
            .all()
            .map((r) => [r.id, r.n])
        : [],
    );
    return found.map((t) => ({ ...t, reports: counts.get(this.idFor(t.id)) ?? 0 }));
  }

  /** Files a new ticket, linked to the conversation it came from. */
  async file(draft: TicketDraft, from: { conversationId?: string | null; summary?: string | null } = {}): Promise<TrackedTicket> {
    const created = await this.tracker.create(draft);
    const ticket: TrackedTicket = { id: created.id ?? created.key, key: created.key, url: created.url, title: draft.title, state: "open" };
    this.remember(ticket, draft.kind);
    if (from.conversationId) this.link(ticket.id, from.conversationId, "filed", from.summary ?? null);
    return ticket;
  }

  /**
   * Adds a repeat report to an existing ticket: a comment on it, and a link so this person hears
   * back too. Returns null when there's no such ticket.
   */
  async add(
    keyOrUrl: string,
    from: { conversationId?: string | null; summary?: string | null; comment: string; kind?: TicketKind | null },
  ): Promise<{ ticket: TrackedTicket; already: boolean; reports: number } | null> {
    const ticket = await this.lookup(keyOrUrl);
    if (!ticket) return null;
    const id = this.idFor(ticket.id);
    const already = Boolean(
      from.conversationId &&
        this.db
          .select()
          .from(schema.ticketLinks)
          .where(and(eq(schema.ticketLinks.ticketId, id), eq(schema.ticketLinks.conversationId, from.conversationId)))
          .get(),
    );
    if (already) return { ticket, already, reports: this.reportCount(id) };
    if (this.tracker.comment) await this.tracker.comment(ticket.id, from.comment).catch((err) => this.log(`tickets: couldn't comment on ${ticket.key}`, err));
    this.remember(ticket, from.kind);
    if (from.conversationId) this.link(ticket.id, from.conversationId, "added", from.summary ?? null, ticket.state !== "open");
    return { ticket, already, reports: this.reportCount(id) };
  }

  /** How many conversations are linked to a ticket. */
  private reportCount(id: string): number {
    return this.db.select({ n: sql<number>`count(*)` }).from(schema.ticketLinks).where(eq(schema.ticketLinks.ticketId, id)).get()?.n ?? 0;
  }

  /** The tickets a conversation filed or was added to. */
  forConversation(conversationId: string): LinkedTicket[] {
    return this.db
      .select({ t: schema.tickets, l: schema.ticketLinks })
      .from(schema.ticketLinks)
      .innerJoin(schema.tickets, eq(schema.tickets.id, schema.ticketLinks.ticketId))
      .where(eq(schema.ticketLinks.conversationId, conversationId))
      .all()
      .map(({ t, l }) => ({ key: t.key, url: t.url, title: t.title, state: t.state, relation: l.relation, notified: Boolean(l.notifiedAt) }));
  }

  /**
   * Asks the tracker about every open ticket someone is waiting on. Done ones notify their
   * reporters; duplicates pass their reporters to the ticket they duplicate. Returns how many
   * people were told.
   */
  async check(now = new Date()): Promise<number> {
    if (!this.tracker.states) return 0;
    const unheard = (state: "open" | "done") =>
      this.db
        .selectDistinct({ t: schema.tickets })
        .from(schema.tickets)
        .innerJoin(schema.ticketLinks, eq(schema.ticketLinks.ticketId, schema.tickets.id))
        .where(and(eq(schema.tickets.tracker, this.tracker.name), eq(schema.tickets.state, state), isNull(schema.ticketLinks.notifiedAt)))
        .all()
        .map((r) => r.t);
    let told = 0;
    // Done already, but a notice didn't go through last time.
    for (const row of unheard("done")) told += await this.tell(row.id);
    const waiting = unheard("open");
    if (!waiting.length) return told;

    const current = new Map((await this.tracker.states(waiting.map((t) => t.ref))).map((t) => [t.id, t]));
    for (const row of waiting) {
      const fresh = current.get(row.ref);
      // Missing usually means deleted or archived; leave it be rather than guess.
      if (!fresh) {
        this.touch(row.id, now);
        continue;
      }
      this.db
        .update(schema.tickets)
        .set({ key: fresh.key, url: fresh.url, title: fresh.title, checkedAt: now })
        .where(eq(schema.tickets.id, row.id))
        .run();
      if (fresh.state === "done") {
        this.close(row.id, "done", now);
        told += await this.tell(row.id);
      } else if (fresh.state === "closed") {
        this.close(row.id, "closed", now);
        if (fresh.duplicateOf) {
          const target = fresh.duplicateOf;
          this.remember(target, row.kind as TicketKind | null);
          this.moveLinks(row.id, this.idFor(target.id));
          if (target.state === "done") told += await this.tell(this.idFor(target.id));
        }
      }
    }
    return told;
  }

  /** Sends the notice to everyone linked to a done ticket who hasn't heard yet. */
  private async tell(ticketId: string): Promise<number> {
    const t = this.db.select().from(schema.tickets).where(eq(schema.tickets.id, ticketId)).get();
    if (!t) return 0;
    if (t.state !== "done") this.close(ticketId, "done", new Date());
    const links = this.db
      .select()
      .from(schema.ticketLinks)
      .where(and(eq(schema.ticketLinks.ticketId, ticketId), isNull(schema.ticketLinks.notifiedAt)))
      .all();
    let told = 0;
    for (const l of links) {
      try {
        await this.opts.notify({ conversationId: l.conversationId, key: t.key, title: t.title, kind: (t.kind as TicketKind | null) ?? null, summary: l.summary, reportedAt: l.createdAt.getTime() });
        this.db.update(schema.ticketLinks).set({ notifiedAt: new Date() }).where(eq(schema.ticketLinks.id, l.id)).run();
        told++;
      } catch (err) {
        this.log(`tickets: couldn't tell ${l.conversationId} that ${t.key} is done`, err);
      }
    }
    return told;
  }

  private async lookup(keyOrUrl: string): Promise<TrackedTicket | null> {
    const text = keyOrUrl.trim();
    const local = this.db
      .select()
      .from(schema.tickets)
      .where(and(eq(schema.tickets.tracker, this.tracker.name), sql`(lower(${schema.tickets.key}) = lower(${text}) or ${schema.tickets.url} = ${text})`))
      .get();
    if (this.tracker.get) {
      const fresh = await this.tracker.get(local?.key ?? text).catch((err) => {
        this.log(`tickets: couldn't look up ${text}`, err);
        return null;
      });
      if (fresh) return fresh;
    }
    return local ? toTracked(local) : null;
  }

  /** Without tracker search: open tickets Wicket filed whose titles share the most words. */
  private searchLocal(text: string, limit: number): TrackedTicket[] {
    const words = new Set(text.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
    if (!words.size) return [];
    return this.db
      .select()
      .from(schema.tickets)
      .where(and(eq(schema.tickets.tracker, this.tracker.name), eq(schema.tickets.state, "open")))
      .all()
      .map((t) => ({ t, score: (t.title.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((w) => words.has(w)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => toTracked(x.t));
  }

  private remember(t: TrackedTicket, kind?: TicketKind | null) {
    const now = new Date();
    this.db
      .insert(schema.tickets)
      .values({ id: this.idFor(t.id), tracker: this.tracker.name, ref: t.id, key: t.key, url: t.url, title: t.title, kind: kind ?? null, state: t.state, createdAt: now })
      .onConflictDoUpdate({
        target: schema.tickets.id,
        set: { key: t.key, url: t.url, title: t.title, ...(kind ? { kind: sql`coalesce(${schema.tickets.kind}, ${kind})` } : {}), ...(t.state === "open" ? {} : { state: t.state }) },
      })
      .run();
  }

  /** `notified` marks the link as already told, e.g. when the ticket was done before they reported it. */
  private link(ref: string, conversationId: string, relation: "filed" | "added", summary: string | null, notified = false) {
    this.db
      .insert(schema.ticketLinks)
      .values({ ticketId: this.idFor(ref), conversationId, relation, summary: summary?.slice(0, 300) ?? null, createdAt: new Date(), notifiedAt: notified ? new Date() : null })
      .onConflictDoNothing()
      .run();
  }

  private moveLinks(from: string, to: string) {
    const sqlite = this.db.$client;
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO ticket_links (ticket_id, conversation_id, relation, summary, created_at, notified_at)
         SELECT ?, conversation_id, 'added', summary, created_at, notified_at FROM ticket_links WHERE ticket_id = ?`,
      )
      .run(to, from);
    sqlite.prepare(`DELETE FROM ticket_links WHERE ticket_id = ?`).run(from);
  }

  private close(id: string, state: "done" | "closed", at: Date) {
    this.db.update(schema.tickets).set({ state, closedAt: at, checkedAt: at }).where(eq(schema.tickets.id, id)).run();
  }

  private touch(id: string, at: Date) {
    this.db.update(schema.tickets).set({ checkedAt: at }).where(eq(schema.tickets.id, id)).run();
  }

  private idFor(ref: string) {
    return `${this.tracker.name}:${ref}`;
  }
}

function toTracked(r: Row): TrackedTicket {
  return { id: r.ref, key: r.key, url: r.url, title: r.title, state: r.state };
}
