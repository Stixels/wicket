import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { ConversationService, PublicMessage } from "./conversations.js";
import { signUserToken, verifyUserToken } from "./identity.js";

export interface ServerOptions {
  allowedOrigins: string[];
  maxMessagesPerConversationPerHour: number;
  maxConversationsPerIpPerHour: number;
  widgetPath?: string;
  /** Serve a test page with the widget at /, for trying it out. */
  playground?: { title: string };
  /** Shared with the host app's backend, which signs user tokens with it. */
  identitySecret?: string;
}

const createBody = z.object({
  reporter: z.object({ id: z.string().optional(), name: z.string().optional(), email: z.string().optional() }).default({}),
  userToken: z.string().max(4000).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});
const sessionBody = z.object({
  userToken: z.string().max(4000).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});
const emailBody = z.object({ email: z.string().max(320) });
const messageBody = z.object({
  body: z.string().min(1).max(4000),
  context: z.record(z.string(), z.unknown()).optional(),
});

const summariesBody = z.object({
  conversations: z.array(z.object({ id: z.string().max(64), token: z.string().max(128) })).max(50),
});

export function createServer(service: ConversationService, opts: ServerOptions) {
  const app = new Hono();
  const limiter = new RateLimiter();
  const widgetPath = opts.widgetPath ?? path.resolve("dist/widget.js");

  app.use(
    "/api/*",
    cors({
      origin: (origin) => (opts.allowedOrigins.length === 0 || opts.allowedOrigins.includes(origin) ? origin : null),
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "OPTIONS"],
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/widget.js", (c) => {
    if (!fs.existsSync(widgetPath)) return c.text("widget not built; run npm run build:widget", 404);
    c.header("Content-Type", "application/javascript; charset=utf-8");
    c.header("Cache-Control", "public, max-age=300");
    return c.body(fs.readFileSync(widgetPath, "utf8"));
  });

  if (opts.playground) {
    const title = JSON.stringify(opts.playground.title);
    app.get("/", (c) => {
      // With an identity secret, the page signs in as a test user, like a host app's backend would.
      const as = c.req.query("as");
      const plan = c.req.query("plan");
      const token =
        opts.identitySecret && as !== "visitor"
          ? signUserToken({ sub: "local-test", name: "Local test", ...(plan ? { plan } : {}) }, opts.identitySecret, 3600)
          : null;
      const user = token ? `userToken: ${JSON.stringify(token)},` : as === "visitor" ? "" : `user: { id: "local-test", name: "Local test" },`;
      return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wicket playground</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:64px auto;padding:0 16px;color:#222}code{background:#f2f2f2;padding:2px 5px;border-radius:4px}</style>
</head><body>
<h1>Wicket playground</h1>
<p>This page stands in for your app. Open the chat button in the corner and send a message. With Discord set up, it shows up as a post in <code>#support-inbox</code>, and replying there sends the reply back here.</p>
<p>${token ? `Signed in as a test user${plan ? ` on the <code>${escapeHtml(plan)}</code> plan` : ""}.` : as === "visitor" ? "Not signed in." : "Set <code>IDENTITY_SECRET</code> to try signed-in profiles."} Try it as: <a href="/">signed in</a> · <a href="/?plan=pro">pro plan</a> · <a href="/?as=visitor">visitor</a></p>
<p>Turn this page off with <code>PLAYGROUND=false</code>.</p>
<script src="/widget.js"></script>
<script>Wicket.init({ title: ${title}, ${user} context: { area: "playground" } });</script>
</body></html>`);
    });
  }

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
    return c.json(service.create(parsed.data.reporter, parsed.data.context, { identity, visitorKey: clientIp(c) }), 201);
  });

  // The widget keeps the id and token of each conversation it started and asks for their summaries.
  app.post("/api/conversations/summaries", async (c) => {
    const parsed = summariesBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    const conversations = parsed.data.conversations
      .filter((x) => service.authorize(x.id, x.token))
      .map((x) => service.summary(x.id)!)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return c.json({ conversations });
  });

  app.get("/api/conversations/:id/messages", (c) => {
    const conv = service.authorize(c.req.param("id"), bearer(c) ?? "");
    if (!conv) return c.json({ error: "Not found" }, 404);
    return c.json({ status: conv.status, messages: service.list(conv.id, Number(c.req.query("after") ?? 0)) });
  });

  app.post("/api/conversations/:id/messages", async (c) => {
    const conv = service.authorize(c.req.param("id"), bearer(c) ?? "");
    if (!conv) return c.json({ error: "Not found" }, 404);
    if (!limiter.allow(`conv:${conv.id}`, opts.maxMessagesPerConversationPerHour)) {
      return c.json({ error: "Too many messages, try again later" }, 429);
    }
    const parsed = messageBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success || !parsed.data.body.trim()) return c.json({ error: "Invalid message" }, 400);
    const message = await service.postUserMessage(conv.id, parsed.data.body, parsed.data.context);
    return c.json({ message }, 201);
  });

  app.post("/api/conversations/:id/email", async (c) => {
    const conv = service.authorize(c.req.param("id"), bearer(c) ?? "");
    if (!conv) return c.json({ error: "Not found" }, 404);
    const parsed = emailBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success || !(await service.setEmail(conv.id, parsed.data.email))) return c.json({ error: "That doesn't look like an email address" }, 400);
    return c.json({ ok: true });
  });

  // EventSource can't send headers, so the token comes in the query string.
  app.get("/api/conversations/:id/events", (c) => {
    const conv = service.authorize(c.req.param("id"), c.req.query("token") ?? "");
    if (!conv) return c.json({ error: "Not found" }, 404);
    const after = Number(c.req.header("Last-Event-ID") ?? c.req.query("after") ?? 0);

    return streamSSE(c, async (stream) => {
      const send = (event: { type: string; message?: PublicMessage; status?: string }) =>
        stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
          ...(event.message ? { id: String(event.message.id) } : {}),
        });

      for (const message of service.list(conv.id, after)) await send({ type: "message", message });
      await send({ type: "status", status: service.get(conv.id)?.status });

      const listener = (event: { type: string }) => void send(event).catch(() => {});
      service.events.on(conv.id, listener);
      stream.onAbort(() => {
        service.events.off(conv.id, listener);
      });
      while (!stream.aborted) {
        await stream.sleep(25_000);
        await stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {});
      }
      service.events.off(conv.id, listener);
    });
  });

  return app;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
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
