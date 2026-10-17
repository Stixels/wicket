import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { asc, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "./db/index.js";
import type { Evidence, TicketCard } from "./db/schema.js";
import { citedEvidence, loadAppTools, type AppToolsTurn } from "./appTools.js";
import { ThreadGoneError, type Relay, type RelayFile } from "./adapters/types.js";
import { FileStore, MAX_MODEL_IMAGE_BYTES, MODEL_IMAGE_TYPES, formatSize, type Attachment } from "./files.js";
import type { Agent } from "./agent/agent.js";
import { blocksOf, type Block, type Turn } from "./agent/transcript.js";
import { readDoc, searchDocs } from "./knowledge/index.js";
import type { Identity } from "./identity.js";
import { appToolsUrl, parseSettings, pathFromContext, resolveProfile, type Profile, type Settings } from "./settings.js";
import { UsageLedger, dollarsToMicros } from "./usage.js";
import { Members, type Member } from "./team/members.js";
import type { TicketNotice, TicketDesk } from "./tickets.js";
import type { TicketTools } from "./agent/agent.js";

type Author = "user" | "agent" | "staff" | "system" | "note";
type Status = "agent" | "needs_human" | "human" | "resolved";

export interface PublicMessage {
  id: number;
  author: Author;
  authorName: string | null;
  body: string;
  attachments: Attachment[];
  /** "logged" when something they reported was logged; "planned", "fixed", "shipped" or "declined" as it moves. */
  event?: string;
  /** What the widget draws for an event; `body` is the plain-text version. */
  card?: TicketCard;
  /** On assistant answers: the figures behind it, from the app's tools. */
  evidence?: Evidence[];
  /** On assistant answers: questions to offer next. */
  followUps?: string[];
  /** On assistant answers: the person's thumbs up or down. */
  rating?: "up" | "down" | null;
  createdAt: number;
}

/** What the team sees of a message: also who wrote it and whom a note mentions. */
export interface TeamMessage extends PublicMessage {
  memberId: string | null;
  mentions: string[];
}

/** Every conversation's activity goes out on this channel of `events`, for the team dashboard. */
export const TEAM_EVENTS = "team";

export type TeamEvent =
  | { type: "message"; conversationId: string; message: TeamMessage; who?: string | null; status?: Status }
  | { type: "status"; conversationId: string; status: Status; who?: string | null }
  | { type: "typing"; conversationId: string; memberId: string | null; name: string; source: string }
  | { type: "presence"; conversationId: string; presence: Presence }
  | { type: "rating"; conversationId: string; messageId: number; rating: "up" | "down" | null };

/**
 * Whether the user is around: "viewing" has the chat open in a visible tab, "online" has the page
 * open with the chat closed or in the background, "offline" has no page open.
 */
export interface Presence {
  state: "viewing" | "online" | "offline";
  lastSeenAt: number | null;
}

/** Who on the team wrote something, and where. */
export interface TeamAuthor {
  name: string;
  member?: Member | null;
}

export interface Reporter {
  id?: string;
  name?: string;
  email?: string;
}

export interface ServiceOptions {
  settings?: Settings;
  /** Prices come from settings; pass a ledger to share one, e.g. in tests. */
  ledger?: UsageLedger;
  /** Where attachments are kept. Defaults to a temporary folder (fine for tests). */
  files?: FileStore;
  log?: (msg: string, err?: unknown) => void;
  /** Team replies are emailed when unread, so the waiting message can say so. */
  emailReplies?: boolean;
  /** Files tickets and remembers who reported what. Without it the assistant can't log anything. */
  tickets?: TicketDesk | null;
  /** Where the dashboard lives, for links in tickets. */
  publicUrl?: string;
  /** Step limit for answers that can use the app's tools. */
  appToolSteps?: number;
  /** For tests: how app tools are fetched. */
  fetch?: typeof fetch;
}

export const MESSAGES = {
  waiting: (replyTime?: string) =>
    replyTime ? `Passed to the team. They usually reply within ${replyTime}.` : "Passed to the team. Someone will reply here.",
  willEmail: "We'll email you when they do.",
  joined: (name: string) => `${name} joined the conversation`,
  /** The widget shows this as a "resolved" badge with a button to start a new conversation. */
  resolved: "Marked as resolved",
  overBudget: "You've reached this month's limit for the assistant, so I've passed your message to the team. Someone will reply here.",
  overTotal: "The assistant is unavailable right now, so I've passed your message to the team. Someone will reply here.",
  nearBudget: "Heads up: you've used most of this month's assistant allowance. After that, your messages go straight to the team.",
  /** After a thumbs down, when the person asks for someone to look at it. */
  askedForPerson: "Thanks for letting us know. I've passed this to the team.",
  logged: (what: string, kind: string | null) =>
    kind === "bug" || kind === "docs"
      ? `Logged for the team: ${what}. You'll hear back here when it's ${kind === "bug" ? "fixed" : "updated"}.`
      : `Passed to the team: ${what}. You'll hear back here once they've decided.`,
  alreadyPlanned: (what: string) => `Added your vote: ${what} is already planned. You'll hear back here when it ships.`,
  planned: (what: string) => `Good news: the team is planning to build ${what}. You'll hear back here when it ships.`,
  declined: (what: string, kind: string | null, reason?: string | null) =>
    `The team looked at ${what} and decided not to ${kind === "bug" || kind === "docs" ? "change it" : "build it"} for now.${reason ? ` Here's what they said: "${reason}"` : ""} Thanks for ${kind === "bug" || kind === "docs" ? "raising it" : "suggesting it"}.`,
  shipped: (what: string, kind: string | null) =>
    kind === "bug"
      ? `Good news: ${what} is fixed. Thanks for reporting it, and let me know if you still see it.`
      : kind === "docs"
        ? `Good news: the docs on ${what} are updated. Thanks for pointing it out.`
        : `Good news: ${what} just shipped. Thanks for the suggestion.`,
};

const MAX_BODY = 4000;
const MAX_CONTEXT_JSON = 8000;

/**
 * Owns the conversation lifecycle: stores messages, runs the agent while it is
 * in charge, mirrors everything to the relay and pushes updates to the widget.
 */
export class ConversationService {
  readonly events = new EventEmitter();
  private queues = new Map<string, Promise<void>>();

  readonly settings: Settings;
  readonly ledger: UsageLedger;
  readonly files: FileStore;
  readonly members: Members;
  private log: (msg: string, err?: unknown) => void;
  private emailReplies: boolean;
  readonly tickets: TicketDesk | null;
  private publicUrl: string | null;
  private appToolSteps: number;
  private fetchImpl: typeof fetch;
  /** The newest verified user token per conversation, kept in memory only, for app tool calls during an answer. */
  private userTokens = new Map<string, { token: string; env: string | null }>();
  /** The context last shown to the model per conversation, so a change (another page) is sent again. */
  private sentContext = new Map<string, string>();

  constructor(
    private db: Db,
    private agent: Agent | null,
    private relay: Relay | null,
    opts: ServiceOptions | ((msg: string, err?: unknown) => void) = {},
  ) {
    this.events.setMaxListeners(0);
    const o = typeof opts === "function" ? { log: opts } : opts;
    this.settings = o.settings ?? parseSettings("");
    this.ledger = o.ledger ?? new UsageLedger(db, this.settings.budgets.prices);
    this.files = o.files ?? new FileStore(db, ":memory:");
    this.members = new Members(db);
    this.log = o.log ?? console.log;
    this.emailReplies = Boolean(o.emailReplies);
    this.tickets = o.tickets ?? null;
    this.publicUrl = o.publicUrl?.replace(/\/$/, "") ?? null;
    this.appToolSteps = o.appToolSteps ?? 20;
    this.fetchImpl = o.fetch ?? fetch;
  }

  /**
   * Starts a conversation. `identity` comes from a verified user token and wins over whatever
   * the widget says about the reporter. `visitorKey` (e.g. the IP) is what an anonymous
   * person's spend counts against; it is stored hashed.
   */
  create(
    reporter: Reporter,
    context: Record<string, unknown> | undefined,
    opts: { identity?: Identity | null; visitorKey?: string; userToken?: string; verified?: boolean } = {},
  ) {
    const now = new Date();
    const id = opts.identity;
    const row = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(24).toString("base64url"),
      status: "agent" as const,
      reporterId: clip(id?.id ?? reporter.id, 200),
      reporterName: clip(id?.name ?? reporter.name, 200),
      reporterEmail: clip(id?.email ?? reporter.email, 320),
      userId: id ? clip(id.id, 200) : null,
      plan: id ? clip(id.plan, 100) : null,
      payer: id ? (id.account ? `account:${clip(id.account, 200)}` : `user:${clip(id.id, 200)}`) : `visitor:${hash(opts.visitorKey ?? "unknown")}`,
      budgetMicros: id?.budget != null ? dollarsToMicros(id.budget) : null,
      verified: opts.verified ?? false,
      context: sanitizeContext(context),
      relayThreadId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.conversations).values(row).run();
    if (id && opts.userToken) this.userTokens.set(row.id, { token: opts.userToken, env: id.env });
    return { id: row.id, token: row.token };
  }

  get hasAgent(): boolean {
    return Boolean(this.agent);
  }

  /** The profile that applies to someone, given who they are and the page they're on. */
  profileFor(who: { userId: string | null; plan: string | null; context: Record<string, unknown> | null }): Profile {
    return resolveProfile(this.settings, { signedIn: Boolean(who.userId), plan: who.plan, path: pathFromContext(who.context) });
  }

  /** Saves an email someone left so the team can follow up, and shows it to the team. */
  async setEmail(id: string, email: string): Promise<boolean> {
    const c = this.get(id);
    const clean = email.trim().slice(0, 320);
    if (!c || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return false;
    if (c.userId && c.reporterEmail) return true; // signed-in users already have a verified email
    this.db.update(schema.conversations).set({ reporterEmail: clean, updatedAt: new Date() }).where(eq(schema.conversations.id, id)).run();
    await this.mirror(id, "system", `Email for follow-up: ${clean}`);
    return true;
  }

  /** The widget showed the user messages up to this id; replies after it count as unread. */
  markSeen(id: string, messageId: number) {
    this.db
      .update(schema.conversations)
      .set({ seenMessageId: sql`max(coalesce(${schema.conversations.seenMessageId}, 0), ${messageId})` })
      .where(eq(schema.conversations.id, id))
      .run();
  }

  get(id: string) {
    return this.db.select().from(schema.conversations).where(eq(schema.conversations.id, id)).get();
  }

  authorize(id: string, token: string) {
    const c = this.get(id);
    if (!c) return null;
    const a = Buffer.from(c.token);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? c : null;
  }

  /** What the user sees: everything but the team's notes. */
  list(id: string, afterId = 0): PublicMessage[] {
    return this.rows(id)
      .filter((m) => m.id > afterId && m.author !== "note")
      .map(toPublic);
  }

  /** What the team sees: everything, notes included. */
  teamMessages(id: string): TeamMessage[] {
    return this.rows(id).map(toTeam);
  }

  private rows(id: string) {
    return this.db.select().from(schema.messages).where(eq(schema.messages.conversationId, id)).orderBy(asc(schema.messages.id)).all();
  }

  /** A signed-in user's conversations, newest first, for their history on any device. */
  forUser(userId: string, limit = 50): { id: string; token: string }[] {
    return this.db
      .select({ id: schema.conversations.id, token: schema.conversations.token })
      .from(schema.conversations)
      .where(eq(schema.conversations.userId, userId))
      .orderBy(desc(schema.conversations.updatedAt))
      .limit(limit)
      .all();
  }

  /** What the widget's conversation list shows: the opening message and the latest one. */
  summary(id: string) {
    const c = this.get(id);
    if (!c) return null;
    const messages = this.list(id);
    const first = messages.find((m) => m.author === "user");
    // Status lines ("Marked as resolved", "Alex joined") say less than the last real message.
    const last = [...messages].reverse().find((m) => m.author !== "system") ?? messages.at(-1);
    return {
      id: c.id,
      status: c.status,
      title: (first ? previewText(first) : "").slice(0, 140),
      last: last ? { author: last.author, authorName: last.authorName, body: previewText(last).slice(0, 200), createdAt: last.createdAt } : null,
      updatedAt: last?.createdAt ?? c.createdAt.getTime(),
      /** Something they reported moved (planned, done, declined) and they haven't seen the message yet. */
      news: messages.some((m) => isNews(m) && m.id > (c.seenMessageId ?? 0)),
      /** Where the latest thing they reported here stands, for a status chip in their list. */
      report: [...messages].reverse().find((m) => m.card)?.card ?? null,
    };
  }

  /** Accepts a user message and processes it in the background (one at a time per conversation). */
  async postUserMessage(
    id: string,
    body: string,
    contextUpdate?: Record<string, unknown>,
    attachmentIds: string[] = [],
    signedIn?: { identity: Identity; token: string } | null,
  ): Promise<PublicMessage> {
    const text = body.trim().slice(0, MAX_BODY);
    if (contextUpdate) this.mergeContext(id, contextUpdate);
    if (signedIn) this.refreshIdentity(id, signedIn.identity, signedIn.token);
    const msg = this.addMessage(id, "user", text, null, (messageId) => this.files.claim(id, attachmentIds, messageId));
    this.enqueue(id, () => this.handleUserMessage(id, msg.body, msg.attachments));
    const { memberId: _member, mentions: _mentions, ...pub } = msg;
    return pub;
  }

  /** A fresh token from the same person: keep it for this answer's app tools and take the newest allowance. */
  private refreshIdentity(id: string, identity: Identity, token: string) {
    const c = this.get(id);
    if (!c || !c.userId || c.userId !== identity.id) return;
    this.userTokens.set(id, { token, env: identity.env });
    if (identity.budget != null) {
      this.db.update(schema.conversations).set({ budgetMicros: dollarsToMicros(identity.budget) }).where(eq(schema.conversations.id, id)).run();
    }
  }

  /** A thumbs up or down on one of the assistant's answers; null clears it. */
  rate(id: string, messageId: number, rating: "up" | "down" | null): boolean {
    const row = this.db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
    if (!row || row.conversationId !== id || row.author !== "agent") return false;
    this.db.update(schema.messages).set({ rating }).where(eq(schema.messages.id, messageId)).run();
    const c = this.get(id);
    this.events.emit(TEAM_EVENTS, { type: "rating", conversationId: id, messageId, rating } satisfies TeamEvent);
    if (rating && c?.relayThreadId && this.relay) {
      const line = `${rating === "up" ? "👍" : "👎"} Rated this answer: "${previewText(toPublic(row)).slice(0, 120)}"`;
      void this.relay.post(c.relayThreadId, "system", line).catch((err) => this.log("relay post failed", err));
    }
    return true;
  }

  /** "Tell the team" after a thumbs down: a person takes over, as with any handoff. */
  async askForPerson(id: string, reason = "The person asked for someone to look at an answer they rated down."): Promise<boolean> {
    const c = this.get(id);
    if (!c) return false;
    if (c.status !== "agent") return true;
    this.addMessage(id, "system", MESSAGES.askedForPerson, null);
    await this.handoff(id, reason);
    this.addMessage(id, "system", this.waitingText(id), null);
    return true;
  }

  /**
   * Called by the relay when someone on the team writes in the conversation's thread.
   * `from.authorId` is their id in the relay's tool; it links them to one member across tools.
   */
  async handleStaffReply(
    threadId: string,
    authorName: string,
    body: string,
    files: RelayFile[] = [],
    from: { authorId?: string; avatarUrl?: string; note?: boolean; mentions?: string[] } = {},
  ): Promise<void> {
    const c = this.byThread(threadId);
    if (!c) return;
    const member = from.authorId ? this.members.upsertDiscord(from.authorId, authorName, from.avatarUrl ?? null) : null;
    const name = member?.name ?? authorName;
    if (from.note) {
      const mentions = (from.mentions ?? []).flatMap((id) => this.members.byDiscordId(id)?.id ?? []);
      this.addMessage(c.id, "note", body.slice(0, MAX_BODY), name, undefined, { memberId: member?.id ?? null, mentions });
      return;
    }
    const saved = files.map((f) => this.files.save(c.id, f.name, f.type, f.data));
    this.addStaffMessage(c.id, { name, member }, body, saved.map((f) => f.id));
  }

  /** A reply from the dashboard: goes to the user and to the relay thread, like one written there. */
  async teamReply(id: string, author: TeamAuthor, body: string, attachmentIds: string[] = []): Promise<TeamMessage | null> {
    const c = this.get(id);
    if (!c) return null;
    const msg = this.addStaffMessage(id, author, body, attachmentIds);
    if (c.status === "resolved" && c.relayThreadId && this.relay?.reopen) {
      await this.relay.reopen(c.relayThreadId).catch((err) => this.log("relay reopen failed", err));
    }
    if (!msg.body && !msg.attachments.length) return msg;
    await this.mirror(id, "staff", msg.body, author.name, this.relayFiles(msg.attachments));
    return msg;
  }

  /** Removes one attachment for good, from the dashboard. Its name stays on the message, marked expired. */
  removeFile(id: string, fileId: string): TeamMessage | null {
    const file = this.files.get(fileId);
    if (!file || file.conversationId !== id) return null;
    const { messageId } = this.files.remove(fileId)!;
    const row = messageId == null ? undefined : this.db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).get();
    if (!row) return null;
    const msg = toTeam(row);
    this.events.emit(TEAM_EVENTS, { type: "message", conversationId: id, message: msg } satisfies TeamEvent);
    return msg;
  }

  /** A team-only note from the dashboard. `mentions` are member ids; they get pinged in the relay. */
  async teamNote(id: string, author: TeamAuthor, body: string, mentions: string[] = []): Promise<TeamMessage | null> {
    if (!this.get(id)) return null;
    const known = mentions.flatMap((m) => this.members.get(m) ?? []);
    const msg = this.addMessage(id, "note", body.trim().slice(0, MAX_BODY), author.name, undefined, {
      memberId: author.member?.id ?? null,
      mentions: known.map((m) => m.id),
    });
    const threadId = this.get(id)?.relayThreadId;
    if (threadId && this.relay?.postNote) {
      await this.relay
        .postNote(threadId, { name: author.name, relayId: author.member?.discordId }, msg.body, known.map((m) => ({ name: m.name, relayId: m.discordId })))
        .catch((err) => this.log(`relay note failed for ${id}`, err));
    }
    return msg;
  }

  // Open widget connections per conversation, each with whether its chat is in view.
  private connections = new Map<string, Map<string, boolean>>();

  presenceOf(id: string, row = this.get(id)): Presence {
    const views = [...(this.connections.get(id)?.values() ?? [])];
    const state = views.some(Boolean) ? "viewing" : views.length ? "online" : "offline";
    return { state, lastSeenAt: state === "offline" ? (row?.lastSeenAt?.getTime() ?? null) : Date.now() };
  }

  /** A widget connected to a conversation's live updates. */
  widgetConnected(id: string, cid: string) {
    if (!this.connections.has(id)) this.connections.set(id, new Map());
    this.connections.get(id)!.set(cid, this.connections.get(id)!.get(cid) ?? false);
    this.presenceChanged(id);
  }

  widgetDisconnected(id: string, cid: string) {
    const views = this.connections.get(id);
    if (!views?.delete(cid)) return;
    if (!views.size) this.connections.delete(id);
    this.presenceChanged(id);
  }

  /** The widget says whether the chat is open in a visible tab. */
  widgetViewing(id: string, cid: string, viewing: boolean) {
    const views = this.connections.get(id);
    if (!views?.has(cid) || views.get(cid) === viewing) return;
    views.set(cid, viewing);
    this.presenceChanged(id);
  }

  private lastPresence = new Map<string, Presence["state"]>();

  private presenceChanged(id: string) {
    this.db.update(schema.conversations).set({ lastSeenAt: new Date() }).where(eq(schema.conversations.id, id)).run();
    const presence = this.presenceOf(id);
    if (this.lastPresence.get(id) === presence.state) return;
    if (presence.state === "offline") this.lastPresence.delete(id);
    else this.lastPresence.set(id, presence.state);
    this.events.emit(TEAM_EVENTS, { type: "presence", conversationId: id, presence } satisfies TeamEvent);
  }

  /** Someone on the team is typing in a conversation (in the dashboard, or in the relay's thread). */
  teamTyping(id: string, who: { memberId: string | null; name: string }, source: string) {
    this.events.emit(TEAM_EVENTS, { type: "typing", conversationId: id, memberId: who.memberId, name: who.name, source } satisfies TeamEvent);
  }

  /** Typing seen in a relay thread. */
  typingInThread(threadId: string, authorName: string, authorId?: string) {
    const c = this.byThread(threadId);
    if (!c) return;
    const member = authorId ? this.members.byDiscordId(authorId) : undefined;
    this.teamTyping(c.id, { memberId: member?.id ?? null, name: member?.name ?? authorName }, this.relay?.name ?? "relay");
  }

  private addStaffMessage(id: string, author: TeamAuthor, body: string, attachmentIds: string[]): TeamMessage {
    const memberId = author.member?.id ?? null;
    if (this.get(id)?.status !== "human") this.setStatus(id, "human");
    // Replies from before members existed only have a name.
    const joined = this.rows(id).some(
      (m) => m.author === "staff" && (memberId && m.memberId ? m.memberId === memberId : m.authorName === author.name),
    );
    if (!joined) this.addMessage(id, "system", MESSAGES.joined(author.name), null);
    return this.addMessage(id, "staff", body.trim().slice(0, MAX_BODY), author.name, (messageId) => this.files.claim(id, attachmentIds, messageId), {
      memberId,
    });
  }

  private byThread(threadId: string) {
    return this.db.select().from(schema.conversations).where(eq(schema.conversations.relayThreadId, threadId)).get();
  }

  /** Called by the relay when the team closes a conversation's thread. Returns false if it already was. */
  async resolve(threadId: string, deleted = false): Promise<boolean> {
    const c = this.byThread(threadId);
    if (!c) return false;
    if (deleted) {
      // The post is gone: forget it, so a new message opens a fresh post.
      this.db.update(schema.conversations).set({ relayThreadId: null }).where(eq(schema.conversations.id, c.id)).run();
    }
    return this.resolveConversation(c.id, !deleted);
  }

  /** Marks a conversation resolved (from the dashboard, or the relay). Returns false if it already was. */
  async resolveConversation(id: string, updateRelay = true): Promise<boolean> {
    const c = this.get(id);
    if (!c || c.status === "resolved") return false;
    this.setStatus(c.id, "resolved");
    this.addMessage(c.id, "system", MESSAGES.resolved, null);
    if (updateRelay && c.relayThreadId && this.relay?.markResolved) {
      await this.relay.markResolved(c.relayThreadId).catch((err) => this.log("relay markResolved failed", err));
    }
    return true;
  }

  /** Something this person reported moved (planned, done, declined): tell them in the chat (and by email, when they left one). */
  async ticketNews(n: TicketNotice): Promise<void> {
    const c = this.get(n.conversationId);
    if (!c) return;
    const what = n.summary?.trim() || `"${n.title}"`;
    const card: TicketCard = { type: "ticket", stage: n.stage, kind: n.kind, summary: what, reportedAt: n.reportedAt, doneAt: Date.now(), ...(n.reason ? { reason: n.reason } : {}) };
    const [body, event, note] =
      n.stage === "planned"
        ? [MESSAGES.planned(what), "planned", `📋 ${n.key} is planned, so I let them know.`]
        : n.stage === "declined"
          ? [MESSAGES.declined(what, n.kind, n.reason), "declined", `${n.key} was canceled, so I let them know${n.reason ? " what you said" : ""}.`]
          : [MESSAGES.shipped(what, n.kind), n.kind === "bug" ? "fixed" : "shipped", `✅ ${n.key} is done, so I let them know.`];
    this.addMessage(c.id, "agent", body, null, undefined, { event, card });
    // Straight to the thread, not mirror(): a deleted post shouldn't hand a closed conversation back to the assistant.
    if (c.relayThreadId && this.relay) {
      await this.relay.post(c.relayThreadId, "system", note).catch((err) => this.log(`relay post failed for ${c.id}`, err));
    }
  }

  /** The conversation behind a relay thread, e.g. to link a ticket the team filed from it. */
  conversationForThread(threadId: string): string | null {
    return this.byThread(threadId)?.id ?? null;
  }

  /** Where the team opens a conversation, for links in tickets. */
  dashboardUrl(id: string): string | null {
    return this.publicUrl ? `${this.publicUrl}/admin/c/${id}` : null;
  }

  /** What the assistant can do with tickets in this conversation, if anything. */
  private ticketTools(id: string, cards: TicketCard[]): TicketTools | undefined {
    const desk = this.tickets;
    if (!desk || !this.settings.tickets.assistant) return undefined;
    const source = () => {
      const c = this.get(id);
      const who = c?.reporterName ?? c?.reporterEmail ?? "someone";
      const link = this.dashboardUrl(id);
      return `${who} in chat${link ? ` (${link})` : ""}`;
    };
    // The user sees a card saying it's logged and that they'll hear back, so the reply needn't repeat it.
    const hearBack = desk.canFollow ? " They'll also see a card saying it's logged. Thank them briefly and say it went straight to the team and they'll hear back here." : "";
    const logged = (kind: TicketCard["kind"], summary: string, others = 0, planned = false) => {
      if (desk.canFollow) cards.push({ type: "ticket", stage: planned ? "planned" : "logged", kind, summary: summary.trim().slice(0, 300), reportedAt: Date.now(), ...(planned ? { doneAt: Date.now() } : {}), ...(others ? { others } : {}) });
    };
    return {
      find: async (query) => {
        const found = await desk.find(query);
        if (!found.length) return "No open tickets match.";
        return found.map((t) => `${t.key}: ${t.title}${t.reports ? ` (${t.reports} ${t.reports === 1 ? "report" : "reports"} from chat)` : ""}`).join("\n");
      },
      file: async (input) => {
        const ticket = await desk.file(
          { title: String(input.title).slice(0, 200), kind: input.kind, description: `${input.description}\n\n---\nReported by ${source()}` },
          { conversationId: id, summary: input.user_summary },
        );
        this.addMessage(id, "note", `Filed ${ticket.key}: ${ticket.title}\n${ticket.url}`, "Assistant");
        await this.mirror(id, "system", `🎫 Filed [${ticket.key}](${ticket.url}): ${ticket.title}`);
        logged(input.kind, input.user_summary);
        return `Filed ${ticket.key}.${hearBack}`;
      },
      add: async (input) => {
        const result = await desk.add(String(input.key), {
          conversationId: id,
          summary: input.user_summary,
          kind: input.kind,
          comment: `Another report from ${source()}:\n\n${input.note}`,
        });
        if (!result) return `There's no ticket ${input.key}. Use a key from find_tickets, or file_ticket.`;
        if (result.already) return `This conversation is already on ${result.ticket.key}.`;
        this.addMessage(id, "note", `Added this report to ${result.ticket.key}: ${result.ticket.title}\n${result.ticket.url}`, "Assistant");
        await this.mirror(id, "system", `➕ Added to [${result.ticket.key}](${result.ticket.url}): ${result.ticket.title}`);
        if (result.ticket.state === "done") return `${result.ticket.key} is already done. Tell them it should be fixed already and to make sure they're on the latest version.`;
        logged(input.kind, input.user_summary, result.reports - 1, result.planned);
        if (result.planned) return `Added to ${result.ticket.key}, which the team already plans to build. Tell them it's planned. They'll see a card saying so.`;
        return `Added to ${result.ticket.key}.${hearBack}`;
      },
    };
  }

  /** Waits for queued work on a conversation (used by tests and graceful shutdown). */
  async idle(id: string): Promise<void> {
    await this.queues.get(id);
  }

  private enqueue(id: string, job: () => Promise<void>) {
    const prev = this.queues.get(id) ?? Promise.resolve();
    const next = prev.then(job).catch((err) => this.log(`conversation ${id} failed`, err));
    this.queues.set(id, next);
    next.finally(() => {
      if (this.queues.get(id) === next) this.queues.delete(id);
    });
  }

  private async handleUserMessage(id: string, body: string, attachments: Attachment[] = []) {
    const c = this.get(id);
    if (!c) return;

    await this.mirror(id, "user", body, c.reporterName, this.relayFiles(attachments));
    c.status = this.get(id)?.status ?? c.status; // mirroring can hand a conversation back (deleted post)
    if (c.status === "resolved") {
      // A new question after the team closed it: the assistant takes it first again.
      this.setStatus(id, "agent");
      c.status = "agent";
      if (c.relayThreadId && this.relay?.reopen) await this.relay.reopen(c.relayThreadId).catch((err) => this.log("relay reopen failed", err));
    }
    if (c.status !== "agent") return;

    const profile = this.profileFor(this.get(id) ?? c);
    if (!this.agent || !profile.ai) {
      await this.handoff(id, this.agent ? `New message (${profile.name}: assistant off).` : "New message (no assistant configured).");
      this.addMessage(id, "system", this.waitingText(id), null);
      return;
    }

    if (profile.botCheck && !c.userId && !c.verified) {
      await this.handoff(id, "New message (didn't pass the bot check).");
      this.addMessage(id, "system", this.waitingText(id), null);
      return;
    }

    // A shared profile (e.g. all visitors) spends from one pot; otherwise the person or their account pays.
    const payer = profile.budgetScope === "shared" ? `shared:${profile.name}` : (c.payer ?? `conversation:${id}`);
    const limits = [profile.budget !== undefined ? dollarsToMicros(profile.budget) : null, profile.budgetScope === "shared" ? null : (c.budgetMicros ?? null)].filter(
      (n): n is number => n !== null,
    );
    const limit = limits.length ? Math.min(...limits) : null;
    const total = this.settings.budgets.monthlyTotal;
    const overTotal = total !== undefined && this.ledger.spentThisMonth(null) >= dollarsToMicros(total);
    const spent = limit !== null ? this.ledger.spentThisMonth(payer) : 0;
    if (overTotal || (limit !== null && spent >= limit)) {
      await this.handoff(id, overTotal ? "The assistant's monthly spending cap is reached." : "This person reached their monthly assistant budget.");
      this.addMessage(id, "system", overTotal ? MESSAGES.overTotal : MESSAGES.overBudget, null);
      return;
    }

    const isFirst = this.loadTurns(id).length === 0;
    const content: Block[] = [];
    // The context goes in with the first message, and again whenever it changed (another page, Room or dates).
    const contextJson = c.context ? JSON.stringify(c.context, null, 2) : null;
    if (contextJson && (isFirst || this.sentContext.get(id) !== contextJson)) {
      content.push({ type: "text", text: `<app_context>\n${contextJson}\n</app_context>` });
    }
    if (contextJson) this.sentContext.set(id, contextJson);
    // Files go in as markers; history() turns image markers into images for the model.
    for (const a of attachments) content.push({ type: "text", text: `<wicket-file id="${a.id}"/>` });
    if (body) content.push({ type: "text", text: body });
    const userTurn: Turn = { role: "user", content };
    this.saveTurns(id, [userTurn]);

    this.events.emit(id, { type: "typing" });
    const stopTyping = this.relayTyping(id);
    const cards: TicketCard[] = []; // shown after the reply, so the chat reads "thanks" then "logged"
    try {
      const app = await this.appToolsFor(id, profile);
      const result = await this.agent.respond(
        this.history(id),
        {
          searchDocs: (q) => searchDocs(this.db, q),
          readDoc: (url) => readDoc(this.db, url),
          handoff: (reason) => this.handoff(id, reason),
          tickets: profile.tickets ? this.ticketTools(id, cards) : undefined,
          ...(app ? { app: app.tools } : {}),
        },
        {
          instructions: profile.instructions,
          model: profile.model,
          effort: profile.effort,
          topics: profile.topics,
          offTopic: profile.offTopic,
          followUps: profile.followUps,
          providerOptions: profile.providerOptions,
          ...(app ? { maxSteps: this.appToolSteps } : {}),
        },
      );
      this.saveTurns(id, result.newTurns);
      const cost = this.ledger.record(id, payer, profile.name, result.usage);
      if (result.reply) {
        const evidence = app ? citedEvidence(result.reply, app.evidence) : [];
        this.addMessage(id, "agent", result.reply, null, undefined, {
          ...(evidence.length ? { evidence } : {}),
          ...(result.followUps.length ? { followUps: result.followUps } : {}),
        });
        await this.mirror(id, "agent", result.reply);
      }
      for (const card of cards) {
        const body = card.stage === "planned" ? MESSAGES.alreadyPlanned(card.summary) : MESSAGES.logged(card.summary, card.kind);
        this.addMessage(id, "system", body, null, undefined, { event: "logged", card });
      }
      if (this.get(id)?.status === "needs_human") this.addMessage(id, "system", this.waitingText(id), null);
      if (limit !== null && limit > 0) {
        const warnAt = limit * this.settings.budgets.warnAt;
        if (spent < warnAt && spent + cost >= warnAt && spent + cost < limit) this.addMessage(id, "system", MESSAGES.nearBudget, null);
      }
    } catch (err) {
      this.log(`agent failed on ${id}`, err);
      await this.handoff(id, "The assistant hit an error.");
      const msg = "Sorry, something went wrong on my end. I've asked someone from the team to reply here.";
      this.addMessage(id, "agent", msg, null);
      await this.mirror(id, "agent", msg);
      if (this.get(id)?.status === "needs_human") this.addMessage(id, "system", this.waitingText(id), null);
    } finally {
      stopTyping();
      this.events.emit(id, { type: "idle" });
    }
  }

  /** The host app's tools for this answer, when the profile has them and the person is signed in. */
  private async appToolsFor(id: string, profile: Profile): Promise<AppToolsTurn | null> {
    const signedIn = this.userTokens.get(id);
    const url = signedIn ? appToolsUrl(profile, signedIn.env) : null;
    if (!signedIn || !url) return null;
    try {
      return await loadAppTools(url, signedIn.token, this.get(id)?.context ?? null, this.fetchImpl);
    } catch (err) {
      this.log(`app tools unavailable for ${id}`, err);
      return null;
    }
  }

  private waitingText(id: string): string {
    const c = this.get(id);
    const email = this.emailReplies && c?.reporterEmail && !c.emailOptOut;
    return MESSAGES.waiting(this.settings.team.replyTime) + (email ? ` ${MESSAGES.willEmail}` : "");
  }

  /** Keeps the relay's typing indicator on while the assistant works (Discord's lasts about 10s). */
  private relayTyping(id: string): () => void {
    const threadId = this.get(id)?.relayThreadId;
    const relay = this.relay;
    if (!threadId || !relay?.typing) return () => {};
    const ping = () => void relay.typing!(threadId).catch(() => {});
    ping();
    const timer = setInterval(ping, 8000);
    return () => clearInterval(timer);
  }

  private async handoff(id: string, reason: string) {
    const c = this.get(id);
    if (!c || c.status !== "agent") return;
    this.setStatus(id, "needs_human");
    const threadId = await this.ensureThread(id);
    if (threadId && this.relay) {
      await this.relay.requestHuman(threadId, reason).catch((err) => this.log("relay requestHuman failed", err));
    }
  }

  /** Posts to the conversation's relay thread, creating it on the first message. */
  private async mirror(id: string, author: "user" | "agent" | "staff" | "system", body: string, authorName?: string | null, files: RelayFile[] = []) {
    if (!this.relay) return;
    const c = this.get(id);
    if (!c) return;
    try {
      if (!c.relayThreadId) {
        const threadId = await this.ensureThread(id, author === "user" ? body || "📎 Sent an attachment" : undefined);
        if (author === "user") {
          // The first message went into the thread opener; its files follow right after.
          if (threadId && files.length) await this.relay.post(threadId, "user", "", authorName, files);
          return;
        }
      }
      const threadId = this.get(id)?.relayThreadId;
      if (threadId) await this.relay.post(threadId, author, body, authorName, files);
    } catch (err) {
      if (err instanceof ThreadGoneError) {
        // The team deleted the post. Nobody can answer there, so the assistant takes over again,
        // and the conversation gets a fresh post starting from this message.
        this.db.update(schema.conversations).set({ relayThreadId: null }).where(eq(schema.conversations.id, id)).run();
        if (this.get(id)?.status !== "agent") this.setStatus(id, "agent");
        this.log(`relay thread for ${id} was deleted; opening a new one`);
        if (author === "user") {
          await this.ensureThread(id, body || "📎 Sent an attachment")
            .then((t) => (t && files.length ? this.relay!.post(t, "user", "", authorName, files) : undefined))
            .catch((e) => this.log(`relay reopen failed for ${id}`, e));
        }
        return;
      }
      this.log(`relay post failed for ${id}`, err);
    }
  }

  private async ensureThread(id: string, firstMessage?: string): Promise<string | null> {
    if (!this.relay) return null;
    const c = this.get(id);
    if (!c) return null;
    if (c.relayThreadId) return c.relayThreadId;
    const opener = firstMessage ?? this.list(id).find((m) => m.author === "user")?.body ?? "(no message)";
    const threadId = await this.relay.openThread(c, opener);
    this.db
      .update(schema.conversations)
      .set({ relayThreadId: threadId, updatedAt: new Date() })
      .where(eq(schema.conversations.id, id))
      .run();
    return threadId;
  }

  /** The bytes of a message's files, for the relay. */
  private relayFiles(attachments: Attachment[]): RelayFile[] {
    return attachments.flatMap((a) => {
      const data = this.files.read(a.id);
      return data ? [{ name: a.name, type: a.type, data }] : [];
    });
  }

  /** `attach` claims uploaded files for the new message once its id is known. */
  private addMessage(
    id: string,
    author: Author,
    body: string,
    authorName: string | null,
    attach?: (messageId: number) => Attachment[],
    team: { memberId?: string | null; mentions?: string[]; event?: string; card?: TicketCard; evidence?: Evidence[]; followUps?: string[] } = {},
  ): TeamMessage {
    let row = this.db
      .insert(schema.messages)
      .values({
        conversationId: id,
        author,
        authorName,
        body,
        memberId: team.memberId ?? null,
        mentions: team.mentions?.length ? team.mentions : null,
        event: team.event ?? null,
        card: team.card ?? null,
        evidence: team.evidence ?? null,
        followUps: team.followUps ?? null,
        createdAt: new Date(),
      })
      .returning()
      .get();
    const attachments = attach?.(row.id) ?? [];
    if (attachments.length) {
      row = this.db.update(schema.messages).set({ attachments }).where(eq(schema.messages.id, row.id)).returning().get()!;
    }
    this.db.update(schema.conversations).set({ updatedAt: new Date() }).where(eq(schema.conversations.id, id)).run();
    const msg = toTeam(row);
    // Notes stay with the team; the user's widget never hears about them.
    if (author !== "note") this.events.emit(id, { type: "message", message: toPublic(row) });
    // Who and where it stands, so the dashboard can word a notification without a lookup.
    const c = this.get(id);
    this.events.emit(TEAM_EVENTS, { type: "message", conversationId: id, message: msg, who: c?.reporterName ?? c?.reporterEmail, status: c?.status } satisfies TeamEvent);
    return msg;
  }

  private setStatus(id: string, status: Status) {
    this.db
      .update(schema.conversations)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.conversations.id, id))
      .run();
    this.events.emit(id, { type: "status", status });
    const c = this.get(id);
    this.events.emit(TEAM_EVENTS, { type: "status", conversationId: id, status, who: c?.reporterName ?? c?.reporterEmail } satisfies TeamEvent);
  }

  private mergeContext(id: string, update: Record<string, unknown>) {
    const c = this.get(id);
    if (!c) return;
    const context = sanitizeContext({ ...(c.context ?? {}), ...update });
    this.db.update(schema.conversations).set({ context }).where(eq(schema.conversations.id, id)).run();
  }

  private loadTurns(id: string): Turn[] {
    return this.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, id))
      .orderBy(asc(schema.agentTurns.id))
      .all()
      .map((t) => ({ role: t.role, content: t.content as any }));
  }

  /** Stored turns with consecutive user turns merged, so the API always sees alternating roles. */
  private history(id: string): Turn[] {
    const out: Turn[] = [];
    for (const stored of this.loadTurns(id)) {
      const turn = stored.role === "user" ? { ...stored, content: asBlocks(stored.content).flatMap((b) => this.expandFile(b)) } : stored;
      const last = out[out.length - 1];
      if (last && last.role === "user" && turn.role === "user") {
        last.content = [...asBlocks(last.content), ...asBlocks(turn.content)];
      } else {
        out.push({ role: turn.role, content: turn.content });
      }
    }
    return out;
  }

  /** A file marker becomes the image itself, or a note the model can pass on, so it knows what was sent. */
  private expandFile(block: Block): Block[] {
    if (block.type !== "text") return [block];
    const m = /^<wicket-file id="([\w-]+)"\/>$/.exec(block.text);
    if (!m) return [block];
    const file = this.files.get(m[1]!);
    if (!file) return [{ type: "text", text: "[The user attached a file that is no longer available.]" }];
    if (MODEL_IMAGE_TYPES.has(file.type) && file.size <= MAX_MODEL_IMAGE_BYTES) {
      const data = this.files.read(file.id);
      if (data) {
        return [
          { type: "text", text: `[The user attached an image: ${file.name}]` },
          { type: "image", source: { type: "base64", media_type: file.type, data: data.toString("base64") } },
        ];
      }
    }
    return [{ type: "text", text: `[The user attached ${file.name} (${file.type}, ${formatSize(file.size)}). You can't open it, but the team can.]` }];
  }

  private saveTurns(id: string, turns: Turn[]) {
    if (!turns.length) return;
    this.db
      .insert(schema.agentTurns)
      .values(turns.map((t) => ({ conversationId: id, role: t.role as "user" | "assistant", content: t.content })))
      .run();
  }
}

/** News worth flagging when unseen: something they reported is done. */
/** Events that tell someone their report moved, so they get an unread dot and an email. */
export const NEWS = new Set(["planned", "fixed", "shipped", "declined"]);

export function isNews(m: { event?: string | null }): boolean {
  return m.event != null && NEWS.has(m.event);
}

/** The text of a message, or its first file's name when it only has files. */
function previewText(m: PublicMessage): string {
  return m.body || (m.attachments[0] ? `📎 ${m.attachments[0].name}` : "");
}

const asBlocks = (content: Turn["content"]): Block[] => [...blocksOf(content)];

function toPublic(m: typeof schema.messages.$inferSelect): PublicMessage {
  return {
    id: m.id,
    author: m.author,
    authorName: m.authorName,
    body: m.body,
    attachments: m.attachments ?? [],
    ...(m.event ? { event: m.event } : {}),
    ...(m.card ? { card: m.card } : {}),
    ...(m.evidence?.length ? { evidence: m.evidence } : {}),
    ...(m.followUps?.length ? { followUps: m.followUps } : {}),
    ...(m.author === "agent" ? { rating: m.rating ?? null } : {}),
    createdAt: m.createdAt.getTime(),
  };
}

function toTeam(m: typeof schema.messages.$inferSelect): TeamMessage {
  return { ...toPublic(m), memberId: m.memberId, mentions: m.mentions ?? [] };
}

function hash(v: string): string {
  return crypto.createHash("sha256").update(v).digest("base64url").slice(0, 16);
}

function clip(v: unknown, n: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null;
}

/** Drops anything that looks like a secret or card number and caps the size. */
export function sanitizeContext(ctx: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!ctx || typeof ctx !== "object") return null;
  const redact = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v
        .replace(/\b(?:\d[ -]?){13,19}\b/g, "[redacted-number]")
        .replace(/\b(bearer|token|password|secret|api[_-]?key)\b\s*[:=]\s*\S+/gi, "$1=[redacted]")
        .slice(0, 1000);
    }
    if (Array.isArray(v)) return v.slice(0, 30).map(redact);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v)
          .filter(([k]) => !/pass|secret|token|card|cvc|ssn/i.test(k))
          .slice(0, 50)
          .map(([k, val]) => [k, redact(val)]),
      );
    }
    return v;
  };
  const clean = redact(ctx) as Record<string, unknown>;
  return JSON.stringify(clean).length > MAX_CONTEXT_JSON ? { note: "context too large, dropped" } : clean;
}
