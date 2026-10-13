import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { ConversationService, TEAM_EVENTS, type TeamEvent } from "../src/conversations.js";
import { createServer } from "../src/server.js";
import type { TeamOptions } from "../src/team/routes.js";
import { FakeRelay } from "./helpers.js";

const ORIGIN = "http://localhost";

function setup(team: Partial<TeamOptions> = {}) {
  const db = openDb(":memory:");
  const relay = new FakeRelay();
  // No assistant: every message goes to the team, which keeps these tests about the team side.
  const service = new ConversationService(db, null, relay, () => {});
  void relay.start(
    ({ threadId, authorName, body, files, ...from }) => service.handleStaffReply(threadId, authorName, body, files, from),
    (threadId, deleted) => service.resolve(threadId, deleted),
  );
  const app = createServer(service, {
    allowedOrigins: [],
    maxConversationsPerIpPerHour: 50,
    maxMessagesPerConversationPerHour: 50,
    team: { db, productName: "Escape Director", devLogin: true, discordGuildId: "g1", ...team },
  });
  return { db, relay, service, app };
}

async function userConversation(app: ReturnType<typeof setup>["app"], service: ConversationService, body = "The timer froze") {
  const res = await app.request("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reporter: { name: "Sam" } }),
  });
  const conv = (await res.json()) as { id: string; token: string };
  await app.request(`/api/conversations/${conv.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${conv.token}` },
    body: JSON.stringify({ body }),
  });
  await service.idle(conv.id);
  return conv;
}

/** Signs in through the dev login and returns a fetch helper that carries the cookie. */
async function teammate(app: ReturnType<typeof setup>["app"]) {
  const res = await app.request("/admin/auth/dev", { method: "POST", headers: { Origin: ORIGIN } });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  return (path: string, init: { method?: string; json?: unknown } = {}) =>
    app.request(`/admin${path}`, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      headers: { Cookie: cookie, Origin: ORIGIN, ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
}

async function widgetMessages(app: ReturnType<typeof setup>["app"], conv: { id: string; token: string }) {
  const res = await app.request(`/api/conversations/${conv.id}/messages`, { headers: { Authorization: `Bearer ${conv.token}` } });
  return (await res.json()) as { status: string; messages: { author: string; authorName: string | null; body: string }[] };
}

describe("team dashboard", () => {
  it("keeps the API behind sign-in and rejects writes from other sites", async () => {
    const { app } = setup();
    const res = await app.request("/admin/api/conversations");
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).signIn).toEqual({ discord: false, email: false, dev: true });

    const call = await teammate(app);
    expect((await call("/api/me")).status).toBe(200);

    const forged = await app.request("/admin/api/conversations/x/resolve", {
      method: "POST",
      headers: { Cookie: (await app.request("/admin/auth/dev", { method: "POST", headers: { Origin: ORIGIN } })).headers.get("set-cookie")!.split(";")[0]!, Origin: "https://evil.example" },
    });
    expect(forged.status).toBe(403);
  });

  it("has no dev sign-in unless it is turned on", async () => {
    const { app } = setup({ devLogin: false });
    expect((await app.request("/admin/auth/dev", { method: "POST", headers: { Origin: ORIGIN } })).status).toBe(404);
  });

  it("sends a dashboard reply to the user and to the Discord post", async () => {
    const { app, relay, service } = setup();
    const conv = await userConversation(app, service);
    const call = await teammate(app);

    const res = await call(`/api/conversations/${conv.id}/messages`, { json: { body: "Thanks Sam, looking now." } });
    expect(res.status).toBe(201);

    const seen = await widgetMessages(app, conv);
    expect(seen.status).toBe("human");
    expect(seen.messages.slice(-2)).toMatchObject([
      { author: "system", body: "Local teammate joined the conversation" },
      { author: "staff", authorName: "Local teammate", body: "Thanks Sam, looking now." },
    ]);
    const [thread] = [...relay.threads.values()];
    expect(thread!.posts.at(-1)).toBe("staff: Thanks Sam, looking now.");
  });

  it("shows Discord replies in the dashboard under one teammate, and records who replied", async () => {
    const { app, relay, service } = setup();
    const conv = await userConversation(app, service);
    const [threadId] = [...relay.threads.keys()];

    await relay.staffReply(threadId!, "On it", undefined, { authorName: "Alex", authorId: "d-alex" });
    await relay.staffReply(threadId!, "Fixed in 1.4.3", undefined, { authorName: "Alex R", authorId: "d-alex" });

    const call = await teammate(app);
    await call(`/api/conversations/${conv.id}/messages`, { json: { body: "Confirmed on my side too" } });

    const detail = (await (await call(`/api/conversations/${conv.id}`)).json()) as any;
    // Same Discord id, so one teammate (with their latest name), joined once.
    expect(detail.conversation.participants.map((p: any) => p.name)).toEqual(["Alex R", "Local teammate"]);
    expect(detail.messages.filter((m: any) => m.body.endsWith("joined the conversation")).length).toBe(2);
    const members = (await (await call("/api/members")).json()) as any;
    expect(members.members.map((m: any) => m.name).sort()).toEqual(["Alex R", "Local teammate"]);
  });

  it("keeps notes with the team and pings the teammates they mention", async () => {
    const { app, relay, service } = setup();
    const conv = await userConversation(app, service);
    const [threadId] = [...relay.threads.keys()];
    await relay.staffReply(threadId!, "Hi Sam", undefined, { authorName: "Alex", authorId: "d-alex" });
    const alex = service.members.byDiscordId("d-alex")!;

    const widgetEvents: unknown[] = [];
    service.events.on(conv.id, (e) => widgetEvents.push(e));
    const call = await teammate(app);
    const res = await call(`/api/conversations/${conv.id}/messages`, { json: { body: "@Alex can you take this?", note: true, mentions: [alex.id] } });
    expect(res.status).toBe(201);

    expect(widgetEvents).toEqual([]);
    expect((await widgetMessages(app, conv)).messages.some((m) => m.body.includes("take this"))).toBe(false);
    expect(relay.threads.get(threadId!)!.posts.at(-1)).toBe("note Local teammate: @Alex can you take this? [ping d-alex]");
    // A note doesn't change who the conversation is with.
    expect(service.get(conv.id)!.status).toBe("human");
  });

  it("saves a Discord handoff as a note, not a reply to the user", async () => {
    const { app, relay, service } = setup();
    const conv = await userConversation(app, service);
    const [threadId] = [...relay.threads.keys()];
    const call = await teammate(app);
    const me = ((await (await call("/api/me")).json()) as any).member;
    // Link the dev teammate to a Discord id, as a Discord sign-in would.
    service.members.upsertDiscord("d-alex", "Alex");

    await relay.staffReply(threadId!, "<@d-me> can you take this?", undefined, { authorName: "Alex", authorId: "d-alex", note: true, mentions: ["d-unknown"] });
    expect((await widgetMessages(app, conv)).messages.some((m) => m.author === "staff")).toBe(false);
    const detail = (await (await call(`/api/conversations/${conv.id}`)).json()) as any;
    expect(detail.messages.at(-1)).toMatchObject({ author: "note", authorName: "Alex" });
    expect(me.name).toBe("Local teammate");
  });

  it("sorts conversations into views: needs reply, mentions, resolved", async () => {
    const { app, relay, service } = setup();
    const waiting = await userConversation(app, service, "Help please");
    const answered = await userConversation(app, service, "Another question");
    const call = await teammate(app);
    const me = ((await (await call("/api/me")).json()) as any).member;

    await call(`/api/conversations/${answered.id}/messages`, { json: { body: "Here you go" } });
    await relay.staffReply([...relay.threads.keys()][0]!, "Alex here", undefined, { authorName: "Alex", authorId: "d-alex" });
    await service.teamNote(waiting.id, { name: "Alex", member: service.members.byDiscordId("d-alex") }, "@Local teammate yours?", [me.id]);

    const view = async (v: string) => ((await (await call(`/api/conversations?view=${v}`)).json()) as any).conversations.map((c: any) => c.id);
    // Alex replied in the first one but the user hasn't written since; nobody waits.
    expect(await view("needs_reply")).toEqual([]);
    expect(await view("mentions")).toEqual([waiting.id]);

    // My own reply clears the mention.
    await call(`/api/conversations/${waiting.id}/messages`, { json: { body: "Got it" } });
    expect(await view("mentions")).toEqual([]);

    // The user writes back: it needs a reply again.
    await app.request(`/api/conversations/${waiting.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${waiting.token}` },
      body: JSON.stringify({ body: "Still broken" }),
    });
    await service.idle(waiting.id);
    expect(await view("needs_reply")).toEqual([waiting.id]);

    await call(`/api/conversations/${waiting.id}/resolve`, { json: {} });
    expect(await view("resolved")).toEqual([waiting.id]);
    expect(relay.events).toContain(`resolved ${service.get(waiting.id)!.relayThreadId}`);
    const list = ((await (await call("/api/conversations?view=all")).json()) as any).conversations;
    expect(list.find((c: any) => c.id === waiting.id).discordUrl).toBe(`https://discord.com/channels/g1/${service.get(waiting.id)!.relayThreadId}`);
  });

  it("lets a teammate delete an attachment, leaving its name marked removed", async () => {
    const { app, relay, service } = setup();
    const conv = await userConversation(app, service);
    const call = await teammate(app);
    await relay.staffReply([...relay.threads.keys()][0]!, "", [{ name: "card.png", type: "image/png", data: Buffer.from("png") }]);
    const file = service.list(conv.id).at(-1)!.attachments[0]!;

    expect((await call(`/api/conversations/${conv.id}/files/${file.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/files/${file.id}/card.png`)).status).toBe(404);
    const seen = await widgetMessages(app, conv);
    expect((seen.messages.at(-1) as any).attachments).toEqual([{ ...file, expired: true }]);
    expect((await call(`/api/conversations/${conv.id}/files/${file.id}`, { method: "DELETE" })).status).toBe(404);
  });

  it("announces who is typing, from the dashboard or Discord", async () => {
    const { app, relay, service } = setup();
    const conv = await userConversation(app, service);
    const events: TeamEvent[] = [];
    service.events.on(TEAM_EVENTS, (e: TeamEvent) => events.push(e));
    const call = await teammate(app);

    await call(`/api/conversations/${conv.id}/typing`, { json: {} });
    service.typingInThread([...relay.threads.keys()][0]!, "Alex", "d-alex");
    expect(events.filter((e) => e.type === "typing")).toMatchObject([
      { conversationId: conv.id, name: "Local teammate", source: "dashboard" },
      { conversationId: conv.id, name: "Alex", source: "fake" },
    ]);
  });

  it("signs in with Discord only for the team role or an allowed id", async () => {
    const discordApi = (roles: string[]) =>
      (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.endsWith("/oauth2/token")) return Response.json({ access_token: "at" });
        if (u.endsWith("/users/@me")) return Response.json({ id: "d-sam", username: "sam", global_name: "Sam", avatar: "abc" });
        if (u.includes("/guilds/g1/member")) return Response.json({ roles, nick: "Sam (team)" });
        return new Response("nope", { status: 404 });
      }) as typeof fetch;

    const signIn = async (roles: string[]) => {
      const { app, service } = setup({ discord: { clientId: "c", clientSecret: "s", guildId: "g1", teamRoleId: "r-team" }, fetch: discordApi(roles) });
      const start = await app.request("/admin/auth/discord");
      expect(start.status).toBe(302);
      const location = new URL(start.headers.get("location")!);
      expect(location.searchParams.get("scope")).toBe("identify guilds.members.read");
      const state = location.searchParams.get("state")!;
      const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
      const done = await app.request(`/admin/auth/callback?code=x&state=${state}`, { headers: { Cookie: cookie } });
      return { location: done.headers.get("location"), cookie: done.headers.get("set-cookie"), service };
    };

    const ok = await signIn(["r-team"]);
    expect(ok.location).toBe("/admin");
    expect(ok.cookie).toContain("wicket_team=");
    expect(ok.service.members.byDiscordId("d-sam")).toMatchObject({ name: "Sam (team)", avatarUrl: "https://cdn.discordapp.com/avatars/d-sam/abc.png?size=128" });

    const no = await signIn(["r-other"]);
    expect(no.location).toBe("/admin?error=not-team");
  });
});
