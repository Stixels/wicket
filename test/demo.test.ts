import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { Agent } from "../src/agent/agent.js";
import { ConversationService, MESSAGES } from "../src/conversations.js";
import { createServer, type DemoServerOptions } from "../src/server.js";
import { verifyUserToken } from "../src/identity.js";
import { loadConfig } from "../src/config.js";
import { parseSettings } from "../src/settings.js";
import { replaceIndex } from "../src/knowledge/index.js";
import { TicketDesk } from "../src/tickets.js";
import { DemoTracker } from "../src/demo/tracker.js";
import { demoSettingsProblems, demoTeamReply } from "../src/demo/index.js";
import { FakeClient, text, toolCall, type Scripted } from "./helpers.js";

const SECRET = "demo-test-secret-that-is-long-enough-123";
const DEMO_ENV = { DEMO: "true", IDENTITY_SECRET: SECRET, TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "secret" };
const DEMO: DemoServerOptions = {
  scripted: false,
  advanceMinutes: 3,
  budget: 3,
  maxMessageLength: 500,
  maxMessagesPerConversation: 3,
  maxMessagesPerIpPerHour: 40,
  maxConversationsPerIpPerHour: 5,
};
const agentOpts = { model: "claude-haiku-5-5", effort: "low" as const, maxSteps: 6, productName: "Escape Director", productDescription: "" };
const demoYaml = fs.readFileSync("config/demo.yaml", "utf8");

function setup(responses: Scripted[] = [], o: { demo?: boolean } = {}) {
  const demo = o.demo ?? true;
  const db = openDb(":memory:");
  let now = Date.now();
  const settings = parseSettings(demoYaml);
  const tracker = new DemoTracker(db, { advanceMs: 3 * 60_000, backlog: settings.demo!.backlog, now: () => now });
  const desk: TicketDesk = new TicketDesk(db, tracker, {
    notify: async (n) => {
      await service.ticketNews(n);
      const reply = demoTeamReply(n);
      if (reply) service.simulatedTeamReply(n.conversationId, "Alex from the team", reply);
    },
    log: () => {},
  });
  const service = new ConversationService(db, new Agent(new FakeClient(responses), agentOpts), null, { settings, tickets: desk, log: () => {}, demo });
  const app = createServer(service, {
    allowedOrigins: [],
    maxConversationsPerIpPerHour: 50,
    maxMessagesPerConversationPerHour: 50,
    identitySecret: SECRET,
    turnstile: { siteKey: "site", secretKey: "secret", verify: async (t) => t === "good" },
    site: true,
    ...(demo ? { demo: DEMO } : {}),
  });
  return { db, app, service, desk, tracker, later: (ms: number) => (now += ms) };
}

type App = ReturnType<typeof createServer>;

async function post(app: App, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

async function demoToken(app: App, cookie?: string) {
  const res = await post(app, "/api/demo/token", { sub: "admin", name: "Mallory", account: "acme", scope: "erase" }, cookie ? { Cookie: cookie } : {});
  expect(res.status).toBe(200);
  const set = res.headers.get("set-cookie");
  return { token: ((await res.json()) as { token: string }).token, cookie: set ? set.split(";")[0]! : cookie };
}

async function start(app: App, token?: string, turnstileToken = "good") {
  const res = await post(app, "/api/conversations", { userToken: token, turnstileToken, context: { path: "/rooms/treehouse" } });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; token: string };
}

async function send(app: App, conv: { id: string; token: string }, body: string, extra: object = {}) {
  return post(app, `/api/conversations/${conv.id}/messages`, { body, ...extra }, { Authorization: `Bearer ${conv.token}` });
}

const messages = (service: ConversationService, id: string) => service.list(id, 0);

describe("demo mode boot", () => {
  it("refuses a real tracker, Discord or email", () => {
    for (const extra of [
      { LINEAR_API_KEY: "lin_x", LINEAR_TEAM_KEY: "ED" },
      { GITHUB_ISSUES_REPO: "a/b", GITHUB_ISSUES_TOKEN: "t" },
      { DISCORD_BOT_TOKEN: "x" },
      { RELAY: "discord", DISCORD_BOT_TOKEN: "x", DISCORD_GUILD_ID: "1" },
      { RESEND_API_KEY: "re_x" },
      { TEAM_DEV_LOGIN: "true" },
    ]) {
      expect(() => loadConfig({ ...DEMO_ENV, ...extra })).toThrow(/DEMO=true refuses to start/);
    }
    expect(() => loadConfig({ ...DEMO_ENV, LINEAR_API_KEY: "lin_x", LINEAR_TEAM_KEY: "ED", DISCORD_BOT_TOKEN: "x" })).toThrow(
      /unset DISCORD_BOT_TOKEN, LINEAR_API_KEY, LINEAR_TEAM_KEY/,
    );
  });

  it("needs the identity secret and Turnstile keys", () => {
    expect(() => loadConfig({ DEMO: "true" })).toThrow(/IDENTITY_SECRET[\s\S]*TURNSTILE_SITE_KEY/);
    expect(loadConfig(DEMO_ENV).DEMO).toBe(true);
  });

  it("leaves everything else alone when DEMO isn't on", () => {
    expect(loadConfig({ LINEAR_API_KEY: "lin_x", LINEAR_TEAM_KEY: "ED" }).DEMO).toBe(false);
  });

  it("refuses settings that call a real app or post to Discord, and accepts config/demo.yaml", () => {
    expect(demoSettingsProblems(parseSettings(fs.readFileSync("config/wicket.yaml", "utf8")), "claude-haiku-5-5")).toEqual(
      expect.arrayContaining([expect.stringMatching(/appTools/), "announcements.feed posts to Discord"]),
    );
    expect(demoSettingsProblems(parseSettings(demoYaml), "anthropic/claude-haiku-5.5")).toEqual([]);
  });

  it("refuses a model that could cost more per answer than the demo reserves", () => {
    expect(demoSettingsProblems(parseSettings(demoYaml), "anthropic/claude-sonnet-5-5")).toEqual([expect.stringMatching(/claude-sonnet-5-5 costs more/)]);
    expect(demoSettingsProblems(parseSettings(demoYaml), "some/unpriced-model")).toEqual([expect.stringMatching(/unpriced-model costs more/)]);
    const pricey = demoYaml.replace("  visitor:\n", "  visitor:\n    model: claude-opus-5-5\n");
    expect(demoSettingsProblems(parseSettings(pricey), "claude-haiku-5-5")).toEqual([expect.stringMatching(/claude-opus-5-5 costs more/)]);
  });
});

describe("demo sign-in", () => {
  it("is off outside demo mode", async () => {
    const { app } = setup([], { demo: false });
    expect((await post(app, "/api/demo/token", {})).status).toBe(404);
    expect((await app.request("/demo")).status).toBe(404);
  });

  it("only signs the fake customer, with one id per browser", async () => {
    const { app } = setup();
    const first = await demoToken(app);
    const who = verifyUserToken(first.token, SECRET)!;
    expect(who).toMatchObject({ name: "Sam", email: null, account: null, plan: null, budget: null });
    expect(who.id).toMatch(/^demo-[A-Za-z0-9_-]{22,}$/);
    // The same browser keeps its id; another browser gets its own, so nobody sees anyone else's chats.
    const again = await demoToken(app, first.cookie);
    expect(verifyUserToken(again.token, SECRET)!.id).toBe(who.id);
    const other = await demoToken(app);
    expect(verifyUserToken(other.token, SECRET)!.id).not.toBe(who.id);
    // A cookie that isn't a demo id is replaced, not signed.
    const forged = await demoToken(app, "wicket_demo=admin");
    expect(verifyUserToken(forged.token, SECRET)!.id).not.toBe("demo-admin");
  });

  it("puts everyone through the bot check, signed in or not", async () => {
    const { app } = setup();
    const { token } = await demoToken(app);
    const refused = await post(app, "/api/conversations", { userToken: token, turnstileToken: "bad" });
    expect(refused.status).toBe(403);
    expect(((await (await post(app, "/api/session", { userToken: token })).json()) as { botCheck?: unknown }).botCheck).toEqual({ siteKey: "site" });
    await start(app, token);
  });
});

describe("demo pages", () => {
  it("serves /demo in both modes, and the site with the live widget", async () => {
    const { app } = setup();
    const customer = await (await app.request("/demo")).text();
    expect(customer).toContain("userToken:");
    expect(customer).toContain("Signed in as <b>Sam</b>");
    expect(customer).toContain("https://github.com/Stixels/wicket");
    const visitor = await (await app.request("/demo?as=visitor")).text();
    expect(visitor).not.toContain("userToken:");
    const home = await (await app.request("/")).text();
    expect(home).toContain('<script src="/widget.js"></script>');
    // Only /demo with "Signed-in customer" picked signs anyone in; the site's widget is a visitor.
    expect(home).not.toContain("/api/demo/token");
    expect(home).toContain('href="/demo"');
    expect(home).not.toContain("https://wicketchat.com/demo");
    // The page is cached: later visits get the same single widget, not one more each time.
    await app.request("/");
    const again = await (await app.request("/")).text();
    expect(again.match(/<script src="\/widget\.js">/g)).toHaveLength(1);
  });

  it("links the live demo from the site without loading the widget outside demo mode", async () => {
    const { app } = setup([], { demo: false });
    const home = await (await app.request("/")).text();
    expect(home).toContain('href="https://wicketchat.com/demo"');
    expect(home).not.toMatch(/<script[^>]+src="\/widget\.js"/);
  });
});

describe("demo conversations", () => {
  it("files reports to the demo tracker, then the ticket moves on and the team replies", async () => {
    const { app, service, tracker, desk, later } = setup([
      toolCall("file_ticket", { title: "Clue counter stuck after Pause", kind: "bug", description: "Counter stays at 2.", user_summary: "the clue counter getting stuck" }),
      text("Thanks, it's gone straight to the team."),
    ]);
    const { token } = await demoToken(app);
    const conv = await start(app, token);
    expect((await send(app, conv, "The clue counter is stuck after I paused", { userToken: token, report: "bug" })).status).toBe(201);
    await service.idle(conv.id);

    expect(await tracker.get("DEMO-1001")).toMatchObject({ title: "Clue counter stuck after Pause", state: "open" });
    expect(messages(service, conv.id).at(-1)?.card).toMatchObject({ stage: "logged", kind: "bug" });

    expect(await desk.check()).toBe(0);
    later(3 * 60_000);
    expect(await desk.check()).toBe(1);
    const after = messages(service, conv.id);
    expect(after.find((m) => m.card?.stage === "done")?.body).toContain("is fixed");
    expect(after.at(-1)).toMatchObject({ author: "staff", authorName: "Alex from the team" });
    expect(after.at(-1)!.body).toContain("Simulated reply");
    // Nobody is really there, so the assistant keeps the conversation.
    expect(service.get(conv.id)?.status).toBe("agent");
  });

  it("only offers the backlog as possible duplicates", async () => {
    const { tracker } = setup();
    await tracker.create({ title: "Clue counter shows a secret message", kind: "bug", description: "" });
    const found = await tracker.search("clue counter", 5);
    expect(found.map((t) => t.key)).toEqual(["DEMO-101"]);
  });

  it("explains a handoff instead of passing it to a team", async () => {
    const { app, service } = setup([toolCall("handoff_to_human", { reason: "Wants a refund" }), text("In a real install, the team would reply here.")]);
    const conv = await start(app);
    await send(app, conv, "I want a refund");
    await service.idle(conv.id);
    expect(messages(service, conv.id).some((m) => m.body === MESSAGES.demoHandoff)).toBe(true);
    expect(service.get(conv.id)?.status).toBe("agent");
  });

  it("says the month's budget is spent and still searches the docs", async () => {
    const { app, service, db } = setup();
    replaceIndex(db, [{ title: "Clues", heading: "Adding a clue", url: "https://docs.escapedirector.com/clues#adding", body: "Open the puzzle and add a clue." }]);
    service.ledger.record("earlier", "shared:visitor", "visitor", [{ model: "claude-haiku-5-5", input: 30_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }]);
    const conv = await start(app);
    await send(app, conv, "How do I add a clue?");
    await service.idle(conv.id);
    const reply = messages(service, conv.id).at(-1)!;
    expect(reply.author).toBe("agent");
    expect(reply.body).toContain("The demo's AI budget for this month is spent");
    expect(reply.body).toContain("[Clues › Adding a clue](https://docs.escapedirector.com/clues#adding)");
    expect(service.get(conv.id)?.status).toBe("agent");
  });

  it("stops answering while a worst-case answer could still take the month past the cap", async () => {
    const haiku = (dollars: number) => [{ model: "claude-haiku-5-5", input: Math.round(dollars * 10_000_000), output: 0, cacheRead: 0, cacheWrite: 0 }];
    const near = setup([text("Open the puzzle and add a clue.")]);
    near.service.ledger.record("earlier", "shared:visitor", "visitor", haiku(2.85));
    const ok = await start(near.app);
    await send(near.app, ok, "How do I add a clue?");
    await near.service.idle(ok.id);
    expect(messages(near.service, ok.id).at(-1)!.body).toBe("Open the puzzle and add a clue.");

    const edge = setup([text("never sent")]);
    edge.service.ledger.record("earlier", "shared:visitor", "visitor", haiku(2.95));
    const over = await start(edge.app);
    await send(edge.app, over, "How do I add a clue?");
    await edge.service.idle(over.id);
    expect(messages(edge.service, over.id).at(-1)!.body).toContain("The demo's AI budget for this month is spent");
  });

  it("caps message length, conversation length and uploads", async () => {
    const { app, service } = setup([text("one"), text("two"), text("three")]);
    const conv = await start(app);
    expect((await send(app, conv, "x".repeat(501))).status).toBe(400);
    for (const n of [1, 2, 3]) {
      expect((await send(app, conv, `question ${n}`)).status).toBe(201);
      await service.idle(conv.id);
    }
    expect((await send(app, conv, "question 4")).status).toBe(429);
    const form = new FormData();
    form.append("file", new File(["hi"], "a.txt", { type: "text/plain" }));
    const upload = await app.request(`/api/conversations/${conv.id}/files`, { method: "POST", headers: { Authorization: `Bearer ${conv.token}` }, body: form });
    expect(upload.status).toBe(403);
  });
});
