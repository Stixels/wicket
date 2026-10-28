import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { isNews, type ConversationService, type PublicMessage } from "./conversations.js";
import { signUserToken, verifyEraseToken, verifyUserToken } from "./identity.js";
import { teamRoutes, type TeamOptions } from "./team/routes.js";
import type { Db } from "./db/index.js";
import { INLINE_TYPES, MAX_FILES_PER_CONVERSATION, MAX_FILE_BYTES, allowedType } from "./files.js";
import { verifyWebhook, type ReplyEmails } from "./email.js";
import { playgroundPage } from "./playground.js";

export interface ServerOptions {
  allowedOrigins: string[];
  maxMessagesPerConversationPerHour: number;
  maxConversationsPerIpPerHour: number;
  widgetPath?: string;
  /** Serve a test page with the widget at /, for trying it out (at /playground when `site` is on). */
  playground?: { title: string };
  /** Serve the Wicket marketing site at /. */
  site?: boolean;
  sitePath?: string;
  /** Shared with the host app's backend, which signs user tokens with it. */
  identitySecret?: string;
  /** Cloudflare Turnstile keys, for profiles whose visitors pass a bot check. */
  turnstile?: { siteKey: string; secretKey: string; verify?: (token: string, ip: string) => Promise<boolean> };
  /** The team dashboard at /admin. */
  team?: TeamOptions & { db: Db };
  /** Shown on the standalone chat page that email links open. */
  productName?: string;
  /** Emailing unread team replies, and taking replies by email. */
  email?: { replies: ReplyEmails; webhookSecret?: string };
}

const createBody = z.object({
  reporter: z.object({ id: z.string().optional(), name: z.string().optional(), email: z.string().optional() }).default({}),
  userToken: z.string().max(4000).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  turnstileToken: z.string().max(4000).optional(),
});
const sessionBody = z.object({
  userToken: z.string().max(4000).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});
const emailBody = z.object({ email: z.string().max(320) });
const presenceBody = z.object({ cid: z.string().min(1).max(64), viewing: z.boolean() });
const ratingBody = z.object({ rating: z.enum(["up", "down"]).nullable() });
const handoffBody = z.object({ reason: z.string().max(300).optional() });
const messageBody = z.object({
  body: z.string().max(4000).default(""),
  userToken: z.string().max(4000).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  attachments: z.array(z.string().max(64)).max(10).default([]),
});

const summariesBody = z.object({
  conversations: z.array(z.object({ id: z.string().max(64), token: z.string().max(128) })).max(50),
  /** A signed-in user's other conversations come back too, so their history follows them across devices. */
  userToken: z.string().max(4000).optional(),
});

export function createServer(service: ConversationService, opts: ServerOptions) {
  const app = new Hono();
  const limiter = new RateLimiter();
  const widgetPath = opts.widgetPath ?? path.resolve("dist/widget.js");
  const turnstile = opts.turnstile;
  const verifyTurnstile = turnstile ? (turnstile.verify ?? ((token: string, ip: string) => siteverify(turnstile.secretKey, token, ip))) : null;
  /** Visitors on a profile with a bot check must pass it before the assistant answers. */
  const needsBotCheck = (p: { ai: boolean; botCheck: boolean }, signedIn: boolean) => Boolean(turnstile && p.botCheck && p.ai && service.hasAgent && !signedIn);

  app.use(
    "/api/*",
    cors({
      origin: (origin) => (opts.allowedOrigins.length === 0 || opts.allowedOrigins.includes(origin) ? origin : null),
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  if (opts.team) {
    app.get("/admin/", (c) => c.redirect("/admin"));
    app.route("/admin", teamRoutes(opts.team.db, service, opts.team));
  }

  app.get("/widget.js", (c) => {
    if (!fs.existsSync(widgetPath)) return c.text("widget not built; run npm run build:widget", 404);
    c.header("Content-Type", "application/javascript; charset=utf-8");
    c.header("Cache-Control", "public, max-age=300");
    // Bake the configured theme into the script so the widget opens in the right colors.
    const theme = JSON.stringify(JSON.stringify(service.settings.theme ?? null)).slice(1, -1);
    return c.body(fs.readFileSync(widgetPath, "utf8").replace("__WICKET_SERVER_THEME__", () => theme));
  });

  if (opts.site) {
    const sitePath = opts.sitePath ?? path.resolve("site/index.html");
    let html: string | undefined;
    app.get("/", (c) => {
      html ??= fs.existsSync(sitePath) ? fs.readFileSync(sitePath, "utf8") : undefined;
      if (!html) return c.text("site not found", 404);
      c.header("Cache-Control", "public, max-age=300");
      return c.html(html);
    });
  }

  if (opts.playground) {
    const { title } = opts.playground;
    const base = opts.site ? "/playground" : "/";
    app.get(base, (c) => {
      // With an identity secret, the page signs in as a test user, like a host app's backend would.
      const as = c.req.query("as");
      const plan = c.req.query("plan");
      const token =
        opts.identitySecret && as !== "visitor"
          ? signUserToken({ sub: "local-test", name: "Local test", ...(plan ? { plan } : {}) }, opts.identitySecret, 3600)
          : null;
      const initUser = token ? `userToken: ${JSON.stringify(token)},` : as === "visitor" ? "" : `user: { id: "local-test", name: "Local test" },`;
      const mode = as === "visitor" ? "visitor" : token ? "signed-in" : "unsigned";
      return c.html(playgroundPage({ title, mode, plan, initUser, base }));
    });
  }

  // The host's backend calls this when someone deletes their account. It is safe to repeat; a
  // 502 means some team threads couldn't be removed yet and the caller should try again later.
  app.post("/api/erase", async (c) => {
    const who = verifyEraseToken(bearer(c), opts.identitySecret);
    if (!who) return c.json({ error: "Not allowed" }, 401);
    const result = await service.erase(who);
    return c.json(result, result.failed ? 502 : 200);
  });

  // What the widget should look like for this person on this page (the profile's public parts).
  app.post("/api/session", async (c) => {
    const parsed = sessionBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    const identity = verifyUserToken(parsed.data.userToken, opts.identitySecret);
    const p = service.profileFor({ userId: identity?.id ?? null, plan: identity?.plan ?? null, context: parsed.data.context ?? null });
    return c.json({
      profile: p.name,
      ai: p.ai && service.hasAgent,
      signedIn: Boolean(identity),
      name: identity?.name ?? null,
      askEmail: p.askEmail && !identity?.email,
      ...(needsBotCheck(p, Boolean(identity)) ? { botCheck: { siteKey: turnstile!.siteKey } } : {}),
      theme: service.settings.theme,
      ui: { title: p.title, assistantName: p.assistantName, subtitle: p.subtitle, welcomeTitle: p.welcomeTitle, welcomeSubtitle: p.welcomeSubtitle, placeholder: p.placeholder, suggestions: p.suggestions },
    });
  });

  app.post("/api/conversations", async (c) => {
    if (!limiter.allow(`ip:${clientIp(c)}`, opts.maxConversationsPerIpPerHour)) {
      return c.json({ error: "Too many conversations, try again later" }, 429);
    }
    const parsed = createBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    const identity = verifyUserToken(parsed.data.userToken, opts.identitySecret);
    if (parsed.data.userToken && !identity) return c.json({ error: "Your sign-in expired. Please reload the page." }, 401);
    const p = service.profileFor({ userId: identity?.id ?? null, plan: identity?.plan ?? null, context: parsed.data.context ?? null });
    let verified = false;
    if (needsBotCheck(p, Boolean(identity))) {
      verified = Boolean(parsed.data.turnstileToken) && (await verifyTurnstile!(parsed.data.turnstileToken!, clientIp(c)).catch(() => false));
      if (!verified) return c.json({ error: "Please confirm you're not a robot.", botCheck: true }, 403);
    }
    return c.json(
      service.create(parsed.data.reporter, parsed.data.context, { identity, visitorKey: clientIp(c), userToken: identity ? parsed.data.userToken : undefined, verified }),
      201,
    );
  });

  // The widget keeps the id and token of each conversation it started and asks for their summaries.
  app.post("/api/conversations/summaries", async (c) => {
    const parsed = summariesBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    const identity = verifyUserToken(parsed.data.userToken, opts.identitySecret);
    const mine = identity ? service.forUser(identity.id) : [];
    const local = parsed.data.conversations.filter((x) => service.authorize(x.id, x.token) && !mine.some((m) => m.id === x.id));
    // The token goes back only for the user's own conversations found by their verified id.
    const conversations = [...mine.map((m) => ({ ...service.summary(m.id)!, token: m.token })), ...local.map((x) => service.summary(x.id)!)].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    return c.json({ conversations });
  });

  app.get("/api/conversations/:id/messages", (c) => {
    const conv = service.authorize(c.req.param("id"), bearer(c) ?? "");
    if (!conv) return c.json({ error: "Not found" }, 404);
    const messages = service.list(conv.id, Number(c.req.query("after") ?? 0));
    if (messages.length) service.markSeen(conv.id, messages.at(-1)!.id);
    return c.json({ status: conv.status, messages });
  });

  app.post("/api/conversations/:id/messages", async (c) => {
    const conv = service.authorize(c.req.param("id"), bearer(c) ?? "");
    if (!conv) return c.json({ error: "Not found" }, 404);
    if (!limiter.allow(`conv:${conv.id}`, opts.maxMessagesPerConversationPerHour)) {
      return c.json({ error: "Too many messages, try again later" }, 429);
    }
    const parsed = messageBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success || (!parsed.data.body.trim() && !parsed.data.attachments.length)) return c.json({ error: "Invalid message" }, 400);
    // A fresh token with each message: the app's tools run as this person, with their current allowance.
    const identity = verifyUserToken(parsed.data.userToken, opts.identitySecret);
    const signedIn = identity && parsed.data.userToken ? { identity, token: parsed.data.userToken } : null;
    const message = await service.postUserMessage(conv.id, parsed.data.body, parsed.data.context, parsed.data.attachments, signedIn);
    if (!message.body && !message.attachments.length) return c.json({ error: "Those files couldn't be attached" }, 400);
    return c.json({ message }, 201);
  });

  app.post("/api/conversations/:id/messages/:messageId/rating", async (c) => {
    const conv = service.authorize(c.req.param("id"), bearer(c) ?? "");
    if (!conv) return c.json({ error: "Not found" }, 404);
    const parsed = ratingBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid rating" }, 400);
    if (!service.rate(conv.id, Number(c.req.param("messageId")), parsed.data.rating)) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  // "Tell the team" after a thumbs down.
  app.post("/api/conversations/:id/handoff", async (c) => {
    const conv = service.authorize(c.req.param("id"), bearer(c) ?? "");
    if (!conv) return c.json({ error: "Not found" }, 404);
    const parsed = handoffBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    await service.askForPerson(conv.id, parsed.data.reason);
    return c.json({ ok: true });
  });

  // Upload one file; the message that uses it lists its id. Multipart form with a "file" field.
  const uploadLimit = bodyLimit({ maxSize: MAX_FILE_BYTES + 64 * 1024, onError: (c) => c.json({ error: "Files can be up to 10 MB" }, 413) });
  app.post("/api/conversations/:id/files", uploadLimit, async (c) => {
    const conv = service.authorize(c.req.param("id"), bearer(c) ?? "");
    if (!conv) return c.json({ error: "Not found" }, 404);
    if (Number(c.req.header("Content-Length") ?? 0) > MAX_FILE_BYTES + 64 * 1024) return c.json({ error: "Files can be up to 10 MB" }, 413);
    if (!limiter.allow(`conv:${conv.id}`, opts.maxMessagesPerConversationPerHour)) {
      return c.json({ error: "Too many messages, try again later" }, 429);
    }
    if (service.files.countFor(conv.id) >= MAX_FILES_PER_CONVERSATION) return c.json({ error: "This conversation has reached its file limit" }, 400);
    const form = await c.req.parseBody().catch(() => null);
    const file = form?.file;
    if (!(file instanceof File)) return c.json({ error: "No file" }, 400);
    if (file.size > MAX_FILE_BYTES) return c.json({ error: "Files can be up to 10 MB" }, 413);
    if (!allowedType(file.type)) return c.json({ error: "That type of file can't be attached. Try an image, PDF, video, text or zip file." }, 415);
    const saved = service.files.save(conv.id, file.name, file.type, Buffer.from(await file.arrayBuffer()));
    return c.json({ file: { ...saved, url: fileUrl(saved) } }, 201);
  });

  app.post("/api/conversations/:id/email", async (c) => {
    const conv = service.authorize(c.req.param("id"), bearer(c) ?? "");
    if (!conv) return c.json({ error: "Not found" }, 404);
    const parsed = emailBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success || !(await service.setEmail(conv.id, parsed.data.email))) return c.json({ error: "That doesn't look like an email address" }, 400);
    return c.json({ ok: true });
  });

  // Files are served by their random id, so an <img> can load them without a token.
  app.get("/files/:id/:name?", (c) => {
    const meta = service.files.get(c.req.param("id"));
    const data = meta && service.files.read(meta.id);
    if (!meta || !data) return c.text("Not found", 404);
    c.header("Content-Type", meta.type);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    c.header("Cache-Control", "private, max-age=86400, immutable");
    c.header("Content-Disposition", `${INLINE_TYPES.has(meta.type) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
    return c.body(new Uint8Array(data));
  });

  app.post("/api/conversations/:id/presence", async (c) => {
    const conv = service.authorize(c.req.param("id"), bearer(c) ?? "");
    if (!conv) return c.json({ error: "Not found" }, 404);
    const parsed = presenceBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    service.widgetViewing(conv.id, parsed.data.cid, parsed.data.viewing);
    return c.json({ ok: true });
  });

  // A page with just the chat, for links in emails. The token is in the #fragment, so it never
  // reaches server logs; the widget reads it and keeps the conversation in this browser.
  app.get("/chat/:id", (c) => {
    const name = opts.productName ?? "Support";
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(name)} support</title>
<style>html,body{margin:0;height:100%;background:#0b0b0e}@media (prefers-color-scheme:light){html,body{background:#f4f4f6}}</style>
</head><body>
<script src="/widget.js"></script>
<script>
var id=${JSON.stringify(c.req.param("id")).replace(/</g, "\\u003c")},token=location.hash.slice(1);
if(token)history.replaceState(null,"",location.pathname);
Wicket.init({ page: true, conversation: token ? { id: id, token: token } : undefined });
</script>
</body></html>`);
  });

  if (opts.email) {
    const { replies, webhookSecret } = opts.email;
    const unsubscribed = (ok: boolean) =>
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email updates</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 16px;color:#222">
<p>${ok ? "Done. You won't get more emails about this conversation." : "That link doesn't work anymore."}</p></body>`;
    // A GET only asks, so link scanners in inboxes can't unsubscribe anyone; the button and
    // mail apps' one-click unsubscribe POST.
    app.get("/email/unsubscribe/:id/:sig", (c) =>
      c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email updates</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 16px;color:#222">
<p>Stop emails about this conversation? You can still read and reply in the chat.</p>
<form method="post"><button style="font:inherit;padding:10px 16px;border-radius:10px;border:0;background:#16161d;color:#fff;cursor:pointer">Stop emails</button></form></body>`),
    );
    app.post("/email/unsubscribe/:id/:sig", (c) => {
      const ok = replies.unsubscribe(c.req.param("id"), c.req.param("sig"));
      return c.html(unsubscribed(ok), ok ? 200 : 404);
    });
    // Resend's webhook for received email. It only carries the id; the email itself is fetched from Resend.
    app.post("/email/inbound", async (c) => {
      const raw = await c.req.text();
      if (
        webhookSecret &&
        !verifyWebhook(webhookSecret, { id: c.req.header("svix-id"), timestamp: c.req.header("svix-timestamp"), signature: c.req.header("svix-signature") }, raw)
      ) {
        return c.json({ error: "Bad signature" }, 401);
      }
      let event: { type?: string; data?: { email_id?: string } };
      try {
        event = JSON.parse(raw);
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }
      if (event.type === "email.received" && event.data?.email_id) await replies.receive(event.data.email_id);
      return c.json({ ok: true });
    });
  }

  // EventSource can't send headers, so the token comes in the query string.
  app.get("/api/conversations/:id/events", (c) => {
    const conv = service.authorize(c.req.param("id"), c.req.query("token") ?? "");
    if (!conv) return c.json({ error: "Not found" }, 404);
    const after = Number(c.req.header("Last-Event-ID") ?? c.req.query("after") ?? 0);

    return streamSSE(c, async (stream) => {
      const send = (event: { type: string; message?: PublicMessage & { unseen?: boolean }; status?: string }) => {
        if (event.message) service.markSeen(conv.id, event.message.id);
        return stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
          ...(event.message ? { id: String(event.message.id) } : {}),
        });
      };

      // News the user hasn't seen yet, however old, so the widget can badge the launcher for it.
      const seenBefore = conv.seenMessageId ?? 0;
      for (const message of service.list(conv.id, after)) {
        await send({ type: "message", message: isNews(message) && message.id > seenBefore ? { ...message, unseen: true } : message });
      }
      await send({ type: "status", status: service.get(conv.id)?.status });

      const listener = (event: { type: string }) => void send(event).catch(() => {});
      service.events.on(conv.id, listener);
      // Each open widget names its connection, so it can say whether its chat is in view.
      const cid = (c.req.query("cid") ?? "").slice(0, 64) || crypto.randomUUID();
      service.widgetConnected(conv.id, cid);
      let gone = false;
      const leave = () => {
        if (gone) return;
        gone = true;
        service.events.off(conv.id, listener);
        service.widgetDisconnected(conv.id, cid);
      };
      stream.onAbort(leave);
      while (!stream.aborted) {
        await stream.sleep(25_000);
        await stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {});
      }
      leave();
    });
  });

  return app;
}

function fileUrl(f: { id: string; name: string }): string {
  return `/files/${f.id}/${encodeURIComponent(f.name)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/** Asks Cloudflare whether a Turnstile token is good. */
async function siteverify(secret: string, token: string, ip: string): Promise<boolean> {
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, response: token, ...(ip !== "unknown" ? { remoteip: ip } : {}) }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean };
  return data.success === true;
}

function bearer(c: Context): string | null {
  const h = c.req.header("Authorization");
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

function clientIp(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";
}

/** Fixed one-hour windows kept in memory; enough for a single instance. */
export class RateLimiter {
  private hits = new Map<string, { windowStart: number; count: number }>();
  allow(key: string, max: number, now = Date.now()): boolean {
    const hour = 3_600_000;
    const entry = this.hits.get(key);
    if (!entry || now - entry.windowStart >= hour) {
      this.hits.set(key, { windowStart: now, count: 1 });
      if (this.hits.size > 10_000) this.prune(now);
      return true;
    }
    entry.count++;
    return entry.count <= max;
  }
  private prune(now: number) {
    for (const [k, v] of this.hits) if (now - v.windowStart >= 3_600_000) this.hits.delete(k);
  }
}
