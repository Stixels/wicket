import crypto from "node:crypto";
import { and, asc, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";
import { schema, type Db } from "./db/index.js";
import type { ConversationService } from "./conversations.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

/** An email received at the reply address. */
export interface InboundMail {
  from: string;
  to: string[];
  text: string | null;
  html: string | null;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
  /** Fetches an email the provider received, by its id from the webhook. */
  received?(id: string): Promise<InboundMail | null>;
}

/** Sends through Resend (resend.com). Its free tier covers a small team. */
export class ResendMailer implements Mailer {
  constructor(
    private apiKey: string,
    private from: string,
    private doFetch: typeof fetch = fetch,
  ) {}

  async send(mail: Mail) {
    const res = await this.doFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: this.from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
        ...(mail.headers ? { headers: mail.headers } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  async received(id: string): Promise<InboundMail | null> {
    const res = await this.doFetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) return null;
    const m = (await res.json()) as { from?: string; to?: string[]; text?: string | null; html?: string | null };
    return { from: m.from ?? "", to: m.to ?? [], text: m.text ?? null, html: m.html ?? null };
  }
}

export interface ReplyEmailOptions {
  productName: string;
  /** Where links in emails point, e.g. https://wicket.example.com */
  publicUrl: string;
  /** Domain that receives replies (reply+<conversation>@domain). Without it, replies to the email go nowhere useful. */
  replyDomain?: string;
  /** How long a team reply sits unread before it's emailed. */
  delayMs?: number;
  /** At most one email per conversation in this window. */
  minGapMs?: number;
}

const REPLY_MARKER = "Reply above this line to answer.";

/** What gets emailed when unread: team replies, and news like a reported bug being fixed. */
const EMAILED = or(eq(schema.messages.author, "staff"), inArray(schema.messages.event, ["fixed", "shipped"]));

/**
 * Emails team replies the user hasn't seen in the widget, so nobody has to keep a tab open
 * waiting. A reply to the email lands back in the conversation.
 */
export class ReplyEmails {
  private delayMs: number;
  private minGapMs: number;
  private base: string;

  constructor(
    private db: Db,
    private service: ConversationService,
    private mailer: Mailer,
    private opts: ReplyEmailOptions,
  ) {
    this.delayMs = opts.delayMs ?? 5 * 60_000;
    this.minGapMs = opts.minGapMs ?? 60 * 60_000;
    this.base = opts.publicUrl.replace(/\/$/, "");
  }

  get canReceive(): boolean {
    return Boolean(this.opts.replyDomain && this.mailer.received);
  }

  /** Sends what's due. Run it every minute or so. Returns how many emails went out. */
  async sweep(now = Date.now()): Promise<number> {
    const latestStaff = sql<number>`max(${schema.messages.id})`;
    const due = this.db
      .select({ id: schema.conversations.id, latest: latestStaff, latestAt: sql<number>`max(${schema.messages.createdAt})` })
      .from(schema.conversations)
      .innerJoin(schema.messages, and(eq(schema.messages.conversationId, schema.conversations.id), EMAILED))
      .where(and(isNotNull(schema.conversations.reporterEmail), sql`coalesce(${schema.conversations.emailOptOut}, 0) = 0`))
      .groupBy(schema.conversations.id)
      .having(
        and(
          sql`${latestStaff} > coalesce(${schema.conversations.seenMessageId}, 0)`,
          sql`${latestStaff} > coalesce(${schema.conversations.emailedMessageId}, 0)`,
          // Wait for the team to finish writing, and give the widget a chance to show it.
          sql`max(${schema.messages.createdAt}) <= ${now - this.delayMs}`,
          sql`coalesce(${schema.conversations.emailedAt}, 0) <= ${now - this.minGapMs}`,
        ),
      )
      .all();

    let sent = 0;
    for (const d of due) {
      const c = this.service.get(d.id)!;
      const after = Math.max(c.seenMessageId ?? 0, c.emailedMessageId ?? 0);
      const replies = this.db
        .select()
        .from(schema.messages)
        .where(and(eq(schema.messages.conversationId, c.id), EMAILED, gt(schema.messages.id, after)))
        .orderBy(asc(schema.messages.id))
        .all();
      if (!replies.length) continue;
      // Mark first, so a failing provider doesn't turn into an email every minute.
      this.db
        .update(schema.conversations)
        .set({ emailedMessageId: d.latest, emailedAt: new Date(now) })
        .where(eq(schema.conversations.id, c.id))
        .run();
      try {
        await this.mailer.send(this.compose(c, replies));
        sent++;
      } catch (err) {
        console.error(`email: couldn't send the reply for ${c.id}`, err);
      }
    }
    return sent;
  }

  private compose(c: typeof schema.conversations.$inferSelect, replies: (typeof schema.messages.$inferSelect)[]): Mail {
    const name = this.opts.productName;
    const from = (r: (typeof replies)[number]) => (r.event ? name : r.authorName || "Team");
    const who = [...new Set(replies.filter((r) => !r.event).map((r) => r.authorName || "The team"))];
    const chat = this.chatUrl(c.id, c.token);
    const unsubscribe = `${this.base}/email/unsubscribe/${c.id}/${sign(c.token, "unsub")}`;
    const canReply = this.canReceive;
    const files = (r: (typeof replies)[number]) => (r.attachments ?? []).filter((a) => !a.expired);

    const text = [
      ...(canReply ? [`## ${REPLY_MARKER} ##`, ""] : []),
      ...replies.flatMap((r) => [
        `${from(r)}:`,
        r.body,
        ...files(r).map((a) => `Attachment: ${a.name} ${this.base}/files/${a.id}/${encodeURIComponent(a.name)}`),
        "",
      ]),
      `Continue the conversation: ${chat}`,
      "",
      `You're getting this because you asked ${name} for help. Stop emails about this conversation: ${unsubscribe}`,
    ].join("\n");

    const html = `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f4f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#16161d">
${canReply ? `<div style="color:#9a9aa6;font-size:12px;text-align:center;margin-bottom:12px">${REPLY_MARKER}</div>` : ""}
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:28px;border:1px solid #e6e6ea">
<div style="font-size:13px;color:#6b6b78;margin-bottom:18px">${escapeHtml(name)} support</div>
${replies
  .map(
    (r) => `<div style="margin-bottom:18px">
<div style="font-weight:600;font-size:14px;margin-bottom:6px">${escapeHtml(from(r))}</div>
<div style="font-size:15px;line-height:1.55;white-space:pre-wrap">${escapeHtml(r.body)}</div>
${files(r)
  .map((a) => `<div style="margin-top:8px"><a href="${this.base}/files/${a.id}/${encodeURIComponent(a.name)}" style="color:#6d5dfc;font-size:14px">📎 ${escapeHtml(a.name)}</a></div>`)
  .join("")}
</div>`,
  )
  .join("")}
<a href="${chat}" style="display:inline-block;margin-top:6px;background:#16161d;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 18px;border-radius:10px">Continue the conversation</a>
${canReply ? `<div style="margin-top:14px;font-size:13px;color:#6b6b78">Or just reply to this email.</div>` : ""}
</div>
<div style="max-width:560px;margin:14px auto 0;font-size:12px;color:#9a9aa6;text-align:center">You're getting this because you asked ${escapeHtml(name)} for help. <a href="${unsubscribe}" style="color:#9a9aa6">Stop emails about this conversation</a></div>
</body></html>`;

    return {
      to: c.reporterEmail!,
      subject: who.length ? `${who.join(" and ")} replied · ${name}` : `Something you reported is done · ${name}`,
      text,
      html,
      replyTo: canReply ? `reply+${c.id}.${sign(c.token, "reply")}@${this.opts.replyDomain}` : undefined,
      headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    };
  }

  chatUrl(id: string, token: string): string {
    return `${this.base}/chat/${id}#${token}`;
  }

  /** Stops emails for a conversation if the link's signature checks out. */
  unsubscribe(id: string, sig: string): boolean {
    const c = this.service.get(id);
    if (!c || !safeEqual(sig, sign(c.token, "unsub"))) return false;
    this.db.update(schema.conversations).set({ emailOptOut: true }).where(eq(schema.conversations.id, id)).run();
    return true;
  }

  /** Handles the provider's "email received" webhook, which carries only the email's id. */
  async receive(emailId: string): Promise<boolean> {
    const mail = await this.mailer.received?.(emailId);
    return mail ? this.inbound(mail) : false;
  }

  /**
   * Posts a reply to the email into its conversation. It has to come to the conversation's own
   * signed address, from the address we emailed.
   */
  async inbound(mail: InboundMail): Promise<boolean> {
    for (const to of mail.to) {
      const m = /reply\+([0-9a-f-]{36})\.([\w-]+)@/i.exec(to);
      if (!m) continue;
      const c = this.service.get(m[1]!.toLowerCase());
      if (!c || !c.reporterEmail || !safeEqual(m[2]!, sign(c.token, "reply"))) continue;
      if (addressOf(mail.from) !== c.reporterEmail.toLowerCase()) return false;
      const body = replyText(mail.text ?? htmlToText(mail.html ?? ""));
      if (!body) return false;
      await this.service.postUserMessage(c.id, body);
      return true;
    }
    return false;
  }
}

/** The new part of an email reply: everything above our marker or the quoted original. */
export function replyText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t.includes(REPLY_MARKER)) break;
    if (/^On .{4,200} wrote:$/i.test(t) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(t) || /^From: /.test(t) || /^>/.test(t)) break;
    // Gmail sometimes wraps "On ... wrote:" over two lines.
    if (/^On /.test(t) && /wrote:$/i.test(lines[i + 1]?.trim() ?? "")) break;
    out.push(lines[i]!);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000);
}

function htmlToText(html: string): string {
  return html
    .replace(/<blockquote[\s\S]*$/i, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function addressOf(from: string): string {
  return (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
}

/** A short signature derived from the conversation's secret token, so links need no other secret. */
export function sign(token: string, purpose: string): string {
  return crypto.createHmac("sha256", token).update(purpose).digest("base64url").slice(0, 16);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Checks a Resend (Svix) webhook signature: base64 HMAC-SHA256 of "id.timestamp.body" with the
 * whsec_ secret, within five minutes.
 */
export function verifyWebhook(secret: string, headers: { id?: string; timestamp?: string; signature?: string }, body: string, now = Date.now()): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return signature.split(" ").some((s) => safeEqual(s.split(",")[1] ?? "", expected));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
