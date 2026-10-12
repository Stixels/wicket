import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { asc, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";
import { schema, type Db } from "./db/index.js";
import { ThreadGoneError, type Relay, type RelayFile } from "./adapters/types.js";
import { FileStore, MAX_MODEL_IMAGE_BYTES, MODEL_IMAGE_TYPES, formatSize, type Attachment } from "./files.js";
import type { Agent } from "./agent/agent.js";
import { searchDocs } from "./knowledge/index.js";
import type { Identity } from "./identity.js";
import { parseSettings, pathFromContext, resolveProfile, type Profile, type Settings } from "./settings.js";
import { UsageLedger, dollarsToMicros } from "./usage.js";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type Author = "user" | "agent" | "staff" | "system";

export interface PublicMessage {
  id: number;
  author: Author;
  authorName: string | null;
  body: string;
  attachments: Attachment[];
  createdAt: number;
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
}

export const MESSAGES = {
  waiting: (replyTime?: string) =>
    replyTime ? `Passed to the team. They usually reply within ${replyTime}.` : "Passed to the team. Someone will reply here.",
  joined: (name: string) => `${name} joined the conversation`,
  overBudget: "You've reached this month's limit for the assistant, so I've passed your message to the team. Someone will reply here.",
  overTotal: "The assistant is unavailable right now, so I've passed your message to the team. Someone will reply here.",
  nearBudget: "Heads up: you've used most of this month's assistant allowance. After that, your messages go straight to the team.",
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
  private log: (msg: string, err?: unknown) => void;

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
    this.log = o.log ?? console.log;
  }

  /**
   * Starts a conversation. `identity` comes from a verified user token and wins over whatever
   * the widget says about the reporter. `visitorKey` (e.g. the IP) is what an anonymous
   * person's spend counts against; it is stored hashed.
   */
  create(reporter: Reporter, context: Record<string, unknown> | undefined, opts: { identity?: Identity | null; visitorKey?: string } = {}) {
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
      payer: id ? `user:${clip(id.id, 200)}` : `visitor:${hash(opts.visitorKey ?? "unknown")}`,
      context: sanitizeContext(context),
      relayThreadId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(schema.conversations).values(row).run();
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

  list(id: string, afterId = 0): PublicMessage[] {
    return this.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, id))
      .orderBy(asc(schema.messages.id))
      .all()
      .filter((m) => m.id > afterId)
      .map(toPublic);
  }

  /** What the widget's conversation list shows: the opening message and the latest one. */
  summary(id: string) {
    const c = this.get(id);
    if (!c) return null;
    const messages = this.list(id);
    const first = messages.find((m) => m.author === "user");
    const last = messages.at(-1);
    return {
      id: c.id,
      status: c.status,
      title: (first ? previewText(first) : "").slice(0, 140),
      last: last ? { author: last.author, authorName: last.authorName, body: previewText(last).slice(0, 200), createdAt: last.createdAt } : null,
      updatedAt: last?.createdAt ?? c.createdAt.getTime(),
    };
  }

  /** Accepts a user message and processes it in the background (one at a time per conversation). */
  async postUserMessage(id: string, body: string, contextUpdate?: Record<string, unknown>, attachmentIds: string[] = []): Promise<PublicMessage> {
    const text = body.trim().slice(0, MAX_BODY);
    if (contextUpdate) this.mergeContext(id, contextUpdate);
    const msg = this.addMessage(id, "user", text, null, (messageId) => this.files.claim(id, attachmentIds, messageId));
    this.enqueue(id, () => this.handleUserMessage(id, msg.body, msg.attachments));
    return msg;
  }

  /** Called by the relay when someone on the team replies in the conversation's thread. */
  async handleStaffReply(threadId: string, authorName: string, body: string, files: RelayFile[] = []): Promise<void> {
    const c = this.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.relayThreadId, threadId))
      .get();
    if (!c) return;
    if (c.status !== "human") this.setStatus(c.id, "human");
    const joined = this.list(c.id).some((m) => m.author === "staff" && m.authorName === authorName);
    if (!joined) this.addMessage(c.id, "system", MESSAGES.joined(authorName), null);
    const saved = files.map((f) => this.files.save(c.id, f.name, f.type, f.data));
    this.addMessage(c.id, "staff", body.slice(0, MAX_BODY), authorName, (messageId) => this.files.claim(c.id, saved.map((f) => f.id), messageId));
  }

  /** Called by the relay when the team closes a conversation's thread. Returns false if it already was. */
  async resolve(threadId: string, deleted = false): Promise<boolean> {
    const c = this.db.select().from(schema.conversations).where(eq(schema.conversations.relayThreadId, threadId)).get();
    if (!c) return false;
    if (deleted) {
      // The post is gone: forget it, so a new message opens a fresh post.
      this.db.update(schema.conversations).set({ relayThreadId: null }).where(eq(schema.conversations.id, c.id)).run();
    }
    if (c.status === "resolved") return false;
    this.setStatus(c.id, "resolved");
    this.addMessage(c.id, "system", "The team marked this conversation as resolved. Write here anytime if you need anything else.", null);
    if (!deleted && this.relay?.markResolved) await this.relay.markResolved(threadId).catch((err) => this.log("relay markResolved failed", err));
    return true;
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
      this.addMessage(id, "system", this.waitingText(), null);
      return;
    }

    const payer = c.payer ?? `conversation:${id}`;
    const limit = profile.budget !== undefined ? dollarsToMicros(profile.budget) : null;
    const total = this.settings.budgets.monthlyTotal;
    const overTotal = total !== undefined && this.ledger.spentThisMonth(null) >= dollarsToMicros(total);
    const spent = limit !== null ? this.ledger.spentThisMonth(payer) : 0;
    if (overTotal || (limit !== null && spent >= limit)) {
      await this.handoff(id, overTotal ? "The assistant's monthly spending cap is reached." : "This person reached their monthly assistant budget.");
      this.addMessage(id, "system", overTotal ? MESSAGES.overTotal : MESSAGES.overBudget, null);
      return;
    }

    const isFirst = this.loadTurns(id).length === 0;
    const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
    if (isFirst && c.context) {
      content.push({ type: "text", text: `<app_context>\n${JSON.stringify(c.context, null, 2)}\n</app_context>` });
    }
    // Files go in as markers; history() turns image markers into images for the model.
    for (const a of attachments) content.push({ type: "text", text: `<wicket-file id="${a.id}"/>` });
    if (body) content.push({ type: "text", text: body });
    const userTurn: MessageParam = { role: "user", content };
    this.saveTurns(id, [userTurn]);

    this.events.emit(id, { type: "typing" });
    const stopTyping = this.relayTyping(id);
    try {
      const result = await this.agent.respond(
        this.history(id),
        {
          searchDocs: (q) => searchDocs(this.db, q),
          handoff: (reason) => this.handoff(id, reason),
        },
        { instructions: profile.instructions, model: profile.model, effort: profile.effort, topics: profile.topics, offTopic: profile.offTopic },
      );
      this.saveTurns(id, result.newTurns);
      const cost = this.ledger.record(id, payer, profile.name, result.usage);
      if (result.reply) {
        this.addMessage(id, "agent", result.reply, null);
        await this.mirror(id, "agent", result.reply);
      }
      if (this.get(id)?.status === "needs_human") this.addMessage(id, "system", this.waitingText(), null);
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
      if (this.get(id)?.status === "needs_human") this.addMessage(id, "system", this.waitingText(), null);
    } finally {
      stopTyping();
      this.events.emit(id, { type: "idle" });
    }
  }

  private waitingText(): string {
    return MESSAGES.waiting(this.settings.team.replyTime);
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
  private async mirror(id: string, author: "user" | "agent" | "system", body: string, authorName?: string | null, files: RelayFile[] = []) {
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
  private addMessage(id: string, author: Author, body: string, authorName: string | null, attach?: (messageId: number) => Attachment[]): PublicMessage {
    let row = this.db
      .insert(schema.messages)
      .values({ conversationId: id, author, authorName, body, createdAt: new Date() })
      .returning()
      .get();
    const attachments = attach?.(row.id) ?? [];
    if (attachments.length) {
      row = this.db.update(schema.messages).set({ attachments }).where(eq(schema.messages.id, row.id)).returning().get()!;
    }
    this.db.update(schema.conversations).set({ updatedAt: new Date() }).where(eq(schema.conversations.id, id)).run();
    const msg = toPublic(row);
    this.events.emit(id, { type: "message", message: msg });
    return msg;
  }

  private setStatus(id: string, status: "agent" | "needs_human" | "human" | "resolved") {
    this.db
      .update(schema.conversations)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.conversations.id, id))
      .run();
    this.events.emit(id, { type: "status", status });
  }

  private mergeContext(id: string, update: Record<string, unknown>) {
    const c = this.get(id);
    if (!c) return;
    const context = sanitizeContext({ ...(c.context ?? {}), ...update });
    this.db.update(schema.conversations).set({ context }).where(eq(schema.conversations.id, id)).run();
  }

  private loadTurns(id: string): MessageParam[] {
    return this.db
      .select()
      .from(schema.agentTurns)
      .where(eq(schema.agentTurns.conversationId, id))
      .orderBy(asc(schema.agentTurns.id))
      .all()
      .map((t) => ({ role: t.role, content: t.content as any }));
  }

  /** Stored turns with consecutive user turns merged, so the API always sees alternating roles. */
  private history(id: string): MessageParam[] {
    const out: MessageParam[] = [];
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
  private expandFile(block: Anthropic.Beta.Messages.BetaContentBlockParam): Anthropic.Beta.Messages.BetaContentBlockParam[] {
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
          { type: "image", source: { type: "base64", media_type: file.type as "image/png", data: data.toString("base64") } },
        ];
      }
    }
    return [{ type: "text", text: `[The user attached ${file.name} (${file.type}, ${formatSize(file.size)}). You can't open it, but the team can.]` }];
  }

  private saveTurns(id: string, turns: MessageParam[]) {
    if (!turns.length) return;
    this.db
      .insert(schema.agentTurns)
      .values(turns.map((t) => ({ conversationId: id, role: t.role as "user" | "assistant", content: t.content })))
      .run();
  }
}

/** The text of a message, or its first file's name when it only has files. */
function previewText(m: PublicMessage): string {
  return m.body || (m.attachments[0] ? `📎 ${m.attachments[0].name}` : "");
}

function asBlocks(content: MessageParam["content"]): Anthropic.Beta.Messages.BetaContentBlockParam[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : [...content];
}

function toPublic(m: typeof schema.messages.$inferSelect): PublicMessage {
  return { id: m.id, author: m.author, authorName: m.authorName, body: m.body, attachments: m.attachments ?? [], createdAt: m.createdAt.getTime() };
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
