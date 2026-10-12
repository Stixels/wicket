import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { schema, type Db } from "../db/index.js";
import { TEAM_EVENTS, type ConversationService, type TeamEvent, type TeamMessage } from "../conversations.js";
import { MAX_FILES_PER_CONVERSATION, MAX_FILE_BYTES, allowedType } from "../files.js";
import { toPublicMember, type Member } from "./members.js";

export interface TeamOptions {
  productName: string;
  /** Discord sign-in. Without it (and without devLogin) nobody can sign in. */
  discord?: {
    clientId: string;
    clientSecret: string;
    /** Server and role whose members may sign in. */
    guildId?: string;
    teamRoleId?: string;
  };
  /** Discord user ids allowed in regardless of roles. */
  allowIds?: string[];
  /** Base URL for the OAuth redirect; defaults to the request's origin. */
  publicUrl?: string;
  /** Local development: sign in with one click as "Local teammate". */
  devLogin?: boolean;
  /** Where the built dashboard lives (app.js, app.css). */
  assetsDir?: string;
  /** For "Open in Discord" links. */
  discordGuildId?: string;
  /** Tests stub Discord's API. */
  fetch?: typeof fetch;
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="7" fill="#6d5dfc"/><path d="M5 7.5 8 17l4-7 4 7 3-9.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

type Env = { Variables: { member: Member } };

const COOKIE = "wicket_team";
const STATE_COOKIE = "wicket_oauth";
const DISCORD_API = "https://discord.com/api/v10";

const messageBody = z.object({
  body: z.string().max(4000).default(""),
  attachments: z.array(z.string().max(64)).max(10).default([]),
  note: z.boolean().default(false),
  mentions: z.array(z.string().max(64)).max(20).default([]),
});

export type InboxView = "open" | "needs_reply" | "mentions" | "resolved" | "all";

/**
 * The team dashboard: a browser app at /admin and its API. Replies made here reach the user's
 * widget and the Discord post; replies made in Discord show up here, all through Wicket's own record.
 */
export function teamRoutes(db: Db, service: ConversationService, opts: TeamOptions) {
  const app = new Hono<Env>();
  const doFetch = opts.fetch ?? fetch;
  const assets = opts.assetsDir ?? path.resolve("dist/admin");
  const redirectUri = (c: Context) => `${opts.publicUrl?.replace(/\/$/, "") ?? origin(c)}/admin/auth/callback`;

  // --- Sign-in -------------------------------------------------------------

  app.get("/auth/discord", (c) => {
    if (!opts.discord) return c.redirect("/admin");
    const state = crypto.randomBytes(16).toString("base64url");
    setCookie(c, STATE_COOKIE, state, { path: "/admin/auth", httpOnly: true, secure: isHttps(c), sameSite: "Lax", maxAge: 600 });
    const url = new URL("https://discord.com/oauth2/authorize");
    url.search = new URLSearchParams({
      client_id: opts.discord.clientId,
      response_type: "code",
      redirect_uri: redirectUri(c),
      scope: opts.discord.guildId && opts.discord.teamRoleId ? "identify guilds.members.read" : "identify",
      state,
      prompt: "none",
    }).toString();
    return c.redirect(url.toString());
  });

  app.get("/auth/callback", async (c) => {
    const d = opts.discord;
    const state = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/admin/auth" });
    const code = c.req.query("code");
    if (!d || !code || !state || state !== c.req.query("state")) return c.redirect("/admin?error=sign-in");
    try {
      const tokenRes = await doFetch(`${DISCORD_API}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: d.clientId,
          client_secret: d.clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri(c),
        }),
      });
      if (!tokenRes.ok) throw new Error(`token exchange ${tokenRes.status}`);
      const { access_token } = (await tokenRes.json()) as { access_token: string };
      const auth = { Authorization: `Bearer ${access_token}` };
      const user = (await (await doFetch(`${DISCORD_API}/users/@me`, { headers: auth })).json()) as {
        id: string;
        username: string;
        global_name?: string | null;
        avatar?: string | null;
      };
      let nick: string | null = null;
      let allowed = Boolean(opts.allowIds?.includes(user.id));
      if (d.guildId && d.teamRoleId) {
        const res = await doFetch(`${DISCORD_API}/users/@me/guilds/${d.guildId}/member`, { headers: auth });
        if (res.ok) {
          const m = (await res.json()) as { roles?: string[]; nick?: string | null };
          nick = m.nick ?? null;
          allowed ||= Boolean(m.roles?.includes(d.teamRoleId));
        }
      }
      if (!allowed) return c.redirect("/admin?error=not-team");
      const avatar = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : null;
      const member = service.members.upsertDiscord(user.id, nick ?? user.global_name ?? user.username, avatar);
      signIn(c, member);
      return c.redirect("/admin");
    } catch (err) {
      console.error("team: Discord sign-in failed", err);
      return c.redirect("/admin?error=sign-in");
    }
  });

  app.post("/auth/dev", (c) => {
    if (!opts.devLogin || !sameOrigin(c)) return c.json({ error: "Not available" }, 404);
    signIn(c, service.members.upsertLocal("local-dev", "Local teammate"));
    return c.json({ ok: true });
  });

  app.post("/auth/logout", (c) => {
    if (!sameOrigin(c)) return c.json({ error: "Forbidden" }, 403);
    service.members.endSession(getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: "/admin" });
    return c.json({ ok: true });
  });

  function signIn(c: Context, member: Member) {
    const token = service.members.createSession(member.id);
    setCookie(c, COOKIE, token, { path: "/admin", httpOnly: true, secure: isHttps(c), sameSite: "Lax", maxAge: 30 * 86_400 });
  }

  // --- API (signed-in teammates only) ----------------------------------------

  app.use("/api/*", async (c, next) => {
    const member = service.members.fromSession(getCookie(c, COOKIE));
    if (!member) {
      return c.json({ error: "Sign in", signIn: { discord: Boolean(opts.discord), dev: Boolean(opts.devLogin) } }, 401);
    }
    // Writes must come from the dashboard itself, not a form on another site.
    if (c.req.method !== "GET" && !sameOrigin(c)) return c.json({ error: "Forbidden" }, 403);
    c.set("member", member);
    await next();
  });

  app.get("/api/me", (c) => c.json({ member: toPublicMember(c.get("member")), productName: opts.productName }));

  app.get("/api/members", (c) => c.json({ members: service.members.list() }));

  app.get("/api/conversations", (c) => {
    const view = (c.req.query("view") ?? "open") as InboxView;
    const me = c.get("member").id;
    const rows = db.select().from(schema.conversations).orderBy(desc(schema.conversations.updatedAt)).limit(300).all();
    const all = rows.map((row) => inboxItem(service, row, me, opts.discordGuildId));
    const views: InboxView[] = ["open", "needs_reply", "mentions", "resolved", "all"];
    const counts = Object.fromEntries(views.map((v) => [v, all.filter((i) => inView(i, v)).length]));
    return c.json({ conversations: all.filter((i) => inView(i, view)), counts });
  });

  app.get("/api/conversations/:id", (c) => {
    const row = service.get(c.req.param("id"));
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json({
      conversation: { ...inboxItem(service, row, c.get("member").id, opts.discordGuildId), context: row.context, createdAt: row.createdAt.getTime() },
      messages: service.teamMessages(row.id),
    });
  });

  app.post("/api/conversations/:id/messages", async (c) => {
    const id = c.req.param("id");
    const member = c.get("member");
    const parsed = messageBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "Invalid message" }, 400);
    const { body, attachments, note, mentions } = parsed.data;
    if (!body.trim() && (note || !attachments.length)) return c.json({ error: "Write something first" }, 400);
    const author = { name: member.name, member };
    const message = note ? await service.teamNote(id, author, body, mentions) : await service.teamReply(id, author, body, attachments);
    if (!message) return c.json({ error: "Not found" }, 404);
    return c.json({ message }, 201);
  });

  app.post("/api/conversations/:id/typing", (c) => {
    const id = c.req.param("id");
    if (!service.get(id)) return c.json({ error: "Not found" }, 404);
    const member = c.get("member");
    service.teamTyping(id, { memberId: member.id, name: member.name }, "dashboard");
    return c.json({ ok: true });
  });

  app.post("/api/conversations/:id/resolve", async (c) => {
    const id = c.req.param("id");
    if (!service.get(id)) return c.json({ error: "Not found" }, 404);
    await service.resolveConversation(id);
    return c.json({ ok: true });
  });

  const uploadLimit = bodyLimit({ maxSize: MAX_FILE_BYTES + 64 * 1024, onError: (c) => c.json({ error: "Files can be up to 10 MB" }, 413) });
  app.post("/api/conversations/:id/files", uploadLimit, async (c) => {
    const id = c.req.param("id");
    if (!service.get(id)) return c.json({ error: "Not found" }, 404);
    if (service.files.countFor(id) >= MAX_FILES_PER_CONVERSATION) return c.json({ error: "This conversation has reached its file limit" }, 400);
    const form = await c.req.parseBody().catch(() => null);
    const file = form?.file;
    if (!(file instanceof File)) return c.json({ error: "No file" }, 400);
    if (file.size > MAX_FILE_BYTES) return c.json({ error: "Files can be up to 10 MB" }, 413);
    if (!allowedType(file.type)) return c.json({ error: "That type of file can't be attached" }, 415);
    const saved = service.files.save(id, file.name, file.type, Buffer.from(await file.arrayBuffer()));
    return c.json({ file: saved }, 201);
  });

  // Live updates for every conversation: new messages, status changes, who is typing.
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const listener = (event: TeamEvent) => void stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => {});
      service.events.on(TEAM_EVENTS, listener);
      stream.onAbort(() => {
        service.events.off(TEAM_EVENTS, listener);
      });
      await stream.writeSSE({ event: "ready", data: "{}" });
      while (!stream.aborted) {
        await stream.sleep(25_000);
        await stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {});
      }
      service.events.off(TEAM_EVENTS, listener);
    }),
  );

  // --- The app itself ----------------------------------------------------------

  app.get("/app.js", (c) => asset(c, path.join(assets, "app.js"), "application/javascript; charset=utf-8"));
  app.get("/app.css", (c) => asset(c, path.join(assets, "app.css"), "text/css; charset=utf-8"));

  const shell = (c: Context) => {
    const boot = JSON.stringify({ productName: opts.productName, accent: service.settings.theme.accentColor ?? null }).replace(/</g, "\\u003c");
    c.header("Cache-Control", "no-store");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "same-origin");
    return c.html(`<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.productName)} · Wicket</title>
<meta name="color-scheme" content="dark light">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(FAVICON)}">
<link rel="preconnect" href="https://rsms.me/">
<link rel="stylesheet" href="https://rsms.me/inter/inter.css">
<link rel="stylesheet" href="/admin/app.css">
<script>window.WICKET_TEAM=${boot};try{var t=localStorage.getItem("wicket-team-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
</head><body><div id="root"></div><script src="/admin/app.js"></script></body></html>`);
  };
  app.get("/", shell);
  app.get("/c/:id", shell);

  return app;
}

export interface InboxItem {
  id: string;
  status: string;
  title: string;
  reporter: { name: string | null; email: string | null; plan: string | null; signedIn: boolean };
  last: { author: string; authorName: string | null; body: string; createdAt: number } | null;
  updatedAt: number;
  /** Teammates who replied or left a note, in order of first appearance. */
  participants: { memberId: string | null; name: string }[];
  /** The user is waiting on the team. */
  needsReply: boolean;
  /** A note mentions me and I haven't written since. */
  mentionsMe: boolean;
  discordUrl: string | null;
}

export function inboxItem(service: ConversationService, row: typeof schema.conversations.$inferSelect, me: string, guildId?: string): InboxItem {
  const messages = service.teamMessages(row.id);
  const participants: InboxItem["participants"] = [];
  for (const m of messages) {
    if ((m.author !== "staff" && m.author !== "note") || !m.authorName) continue;
    if (!participants.some((p) => (m.memberId ? p.memberId === m.memberId : p.name === m.authorName))) {
      // A teammate's current name, in case it changed since they wrote.
      const name = (m.memberId && service.members.get(m.memberId)?.name) || m.authorName;
      participants.push({ memberId: m.memberId, name });
    }
  }
  const publicMsgs = messages.filter((m) => m.author !== "note" && m.author !== "system");
  const lastPublic = publicMsgs.at(-1);
  const needsReply =
    row.status === "needs_human" || (row.status === "human" && lastPublic?.author === "user");
  const myLast = findLastIndex(messages, (m) => m.memberId === me && (m.author === "staff" || m.author === "note"));
  const mentionsMe = messages.some((m, i) => i > myLast && m.author === "note" && m.mentions.includes(me)) && row.status !== "resolved";
  const first = messages.find((m) => m.author === "user");
  const last = messages.filter((m) => m.author !== "system").at(-1) ?? messages.at(-1);
  return {
    id: row.id,
    status: row.status,
    title: (first ? preview(first) : "New conversation").slice(0, 140),
    reporter: { name: row.reporterName, email: row.reporterEmail, plan: row.plan, signedIn: Boolean(row.userId) },
    last: last ? { author: last.author, authorName: last.authorName, body: preview(last).slice(0, 200), createdAt: last.createdAt } : null,
    updatedAt: last?.createdAt ?? row.createdAt.getTime(),
    participants,
    needsReply,
    mentionsMe,
    discordUrl: guildId && row.relayThreadId ? `https://discord.com/channels/${guildId}/${row.relayThreadId}` : null,
  };
}

function inView(i: InboxItem, view: InboxView): boolean {
  switch (view) {
    case "needs_reply":
      return i.needsReply;
    case "mentions":
      return i.mentionsMe;
    case "resolved":
      return i.status === "resolved";
    case "all":
      return true;
    default:
      return i.status !== "resolved";
  }
}

function preview(m: TeamMessage): string {
  return m.body || (m.attachments[0] ? `📎 ${m.attachments[0].name}` : "");
}

function findLastIndex<T>(arr: T[], fn: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (fn(arr[i]!)) return i;
  return -1;
}

function asset(c: Context, file: string, type: string) {
  if (!fs.existsSync(file)) return c.text("dashboard not built; run npm run build:admin", 404);
  c.header("Content-Type", type);
  c.header("Cache-Control", "no-cache");
  return c.body(fs.readFileSync(file));
}

function origin(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() ?? url.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? url.host;
  return `${proto}://${host}`;
}

function isHttps(c: Context): boolean {
  return origin(c).startsWith("https:");
}


/** Browsers send Origin on POSTs; a mismatch means another site is trying to post as the teammate. */
function sameOrigin(c: Context): boolean {
  const o = c.req.header("origin");
  if (!o) return c.req.header("sec-fetch-site") !== "cross-site";
  return o === origin(c) || o === new URL(c.req.url).origin;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
