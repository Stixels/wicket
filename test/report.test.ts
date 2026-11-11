import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { Agent, splitOffer } from "../src/agent/agent.js";
import { ConversationService } from "../src/conversations.js";
import { createServer } from "../src/server.js";
import { signUserToken } from "../src/identity.js";
import { parseSettings, reportKinds, resolveProfile, settingsWarnings } from "../src/settings.js";
import { TicketDesk } from "../src/tickets.js";
import { EvalTracker } from "../src/eval/tracker.js";
import { FakeClient, FakeRelay, text, toolCall, type Scripted } from "./helpers.js";

const SECRET = "test-secret-that-is-long-enough-1234567890";
const agentOpts = { model: "claude-haiku-5-5", effort: "low" as const, maxSteps: 6, productName: "Escape Director", productDescription: "" };

const SETTINGS = `
profiles:
  visitor:
    tickets: false
    report: both
  default:
    report: both
  bugs:
    report: bug
rules:
  - when: { signedIn: false }
    profile: visitor
  - when: { page: /bugs }
    profile: bugs
`;

function setup(responses: Scripted[], o: { yaml?: string; tracker?: boolean; maxMessages?: number } = {}) {
  const db = openDb(":memory:");
  const client = new FakeClient(responses);
  const relay = new FakeRelay();
  const tracker = new EvalTracker([{ key: "ED-101", kind: "bug", title: "Room timer drifts behind after pausing and resuming a game" }]);
  const desk = o.tracker === false ? null : new TicketDesk(db, tracker, { notify: async () => {}, log: () => {} });
  const service = new ConversationService(db, new Agent(client, agentOpts), relay, { settings: parseSettings(o.yaml ?? SETTINGS), tickets: desk, log: () => {} });
  void relay.start(async () => {});
  const app = createServer(service, { allowedOrigins: [], maxConversationsPerIpPerHour: 50, maxMessagesPerConversationPerHour: o.maxMessages ?? 50, identitySecret: SECRET });
  return { client, relay, tracker, service, app };
}

type App = ReturnType<typeof createServer>;

async function post(app: App, path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

const userToken = () => signUserToken({ sub: "u1", name: "Sam", email: "sam@example.com" }, SECRET);

async function start(app: App, o: { signedIn?: boolean; page?: string } = {}) {
  const token = o.signedIn === false ? undefined : userToken();
  const res = await post(app, "/api/conversations", { userToken: token, context: { page: `https://app.example.com${o.page ?? "/app"}`, appVersion: "2.3.0" } });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; token: string };
}

async function session(app: App, o: { signedIn?: boolean; page?: string } = {}) {
  const res = await post(app, "/api/session", { userToken: o.signedIn === false ? undefined : userToken(), context: { page: `https://app.example.com${o.page ?? "/app"}` } });
  return (await res.json()) as { reports: string[] };
}

describe("report setting", () => {
  it("is off unless a profile turns it on", () => {
    const s = parseSettings(SETTINGS);
    expect(resolveProfile(parseSettings(""), { signedIn: true, plan: null, path: "/" }).report).toBe("none");
    expect(reportKinds(resolveProfile(parseSettings(""), { signedIn: true, plan: null, path: "/" }))).toEqual([]);
    expect(reportKinds(resolveProfile(s, { signedIn: true, plan: null, path: "/app" }))).toEqual(["bug", "feature"]);
    expect(reportKinds(resolveProfile(s, { signedIn: true, plan: null, path: "/bugs" }))).toEqual(["bug"]);
    expect(reportKinds(parseSettings("profiles:\n  default:\n    report: feature").profiles.default!)).toEqual(["feature"]);
  });

  it("is ignored where the assistant can't log tickets, with a warning on boot", () => {
    const s = parseSettings(SETTINGS);
    expect(reportKinds(resolveProfile(s, { signedIn: false, plan: null, path: "/" }))).toEqual([]);
    expect(settingsWarnings(s)).toEqual(["visitor has report: both but tickets: false, so the widget shows no report shortcuts there"]);
    expect(settingsWarnings(parseSettings("profiles:\n  team:\n    ai: false\n    report: bug"))).toEqual([
      "team has report: bug but ai: false, so the widget shows no report shortcuts there",
    ]);
    expect(settingsWarnings(parseSettings("profiles:\n  quiet:\n    tickets: false"))).toEqual([]);
  });

  it("explains a wrong value", () => {
    expect(() => parseSettings("profiles:\n  default:\n    report: bugs")).toThrow(/profiles\.default\.report/);
    expect(() => parseSettings("profiles:\n  default:\n    report: true")).toThrow(/profiles\.default\.report/);
  });
});

describe("report shortcuts", () => {
  it("tells the widget which shortcuts to show", async () => {
    const { app } = setup([]);
    expect((await session(app)).reports).toEqual(["bug", "feature"]);
    expect((await session(app, { page: "/bugs" })).reports).toEqual(["bug"]);
    expect((await session(app, { signedIn: false })).reports).toEqual([]);
    // Without a tracker nothing could be logged, so there are no shortcuts.
    expect((await session(setup([], { tracker: false }).app)).reports).toEqual([]);
  });

  it("guides a bug report to a ticket, then goes back to an ordinary conversation", async () => {
    const { app, client, service, tracker, relay } = setup([
      text("Sorry about that. What did you expect to see, and what steps lead to it?"),
      toolCall("find_tickets", { query: "player screen blank" }),
      toolCall("file_ticket", { title: "Player screen goes blank after a clue", kind: "bug", description: "Blank.\n\n## Context\nApp 2.3.0", user_summary: "the player screen going blank" }),
      text("Thanks, that's gone straight to the team."),
      text("Sure, here's how."),
    ]);
    const conv = await start(app);
    const res = await post(app, `/api/conversations/${conv.id}/messages`, { body: "The player screen goes blank", report: "bug" }, conv.token);
    expect(res.status).toBe(201);
    await service.idle(conv.id);

    expect(service.get(conv.id)?.report).toBe("bug");
    expect(client.requests[0]!.system).toContain('This person chose "Report a bug"');
    expect(client.requests[0]!.system).toContain("what they expected to happen instead");
    // Docs first: a known fix is offered, and only the person saying it worked stops the report.
    expect(client.requests[0]!.system).toContain("search the docs for a known fix");
    expect(client.requests[0]!.system).toContain("If they say the fix solved it, don't log anything");
    expect(client.requests[0]!.system).not.toContain("<offer_report>");
    // The widget context goes with the report.
    expect(JSON.stringify(client.requests[0]!.messages)).toContain("2.3.0");
    // The tag comes first, where the widget showed it from the moment the report was chosen.
    expect(service.list(conv.id).map((m) => `${m.author}: ${m.body}`).slice(0, 2)).toEqual(["system: Bug report", "user: The player screen goes blank"]);
    expect([...relay.threads.values()][0]!.posts).toContain("system: 🐞 Started from Report a bug");

    await post(app, `/api/conversations/${conv.id}/messages`, { body: "After I send a clue, every time. It should show the clue." }, conv.token);
    await service.idle(conv.id);
    expect(client.requests[1]!.system).toContain('This person chose "Report a bug"');
    expect(tracker.log.filed).toMatchObject([{ kind: "bug", title: "Player screen goes blank after a clue" }]);
    expect(service.get(conv.id)?.report).toBeNull();

    await post(app, `/api/conversations/${conv.id}/messages`, { body: "How do I add a clue?" }, conv.token);
    await service.idle(conv.id);
    expect(client.requests.at(-1)!.system).not.toContain("Report a bug");
  });

  it("adds a repeat report to the ticket that exists", async () => {
    const { app, client, service, tracker } = setup([
      toolCall("find_tickets", { query: "timer behind after pause" }),
      toolCall("add_to_ticket", { key: "ED-101", kind: "bug", note: "Every game after a pause.", user_summary: "the timer falling behind after a pause" }),
      text("Thanks, I've added your report."),
    ]);
    const conv = await start(app);
    await post(app, `/api/conversations/${conv.id}/messages`, { body: "The countdown falls behind every time I pause and resume a game. It should pick up where it was.", report: "bug" }, conv.token);
    await service.idle(conv.id);
    expect(client.requests).toHaveLength(3);
    expect(tracker.log).toEqual({ filed: [], added: ["ED-101"] });
    expect(service.get(conv.id)?.report).toBeNull();
  });

  it("tells the assistant a feature request is one to log", async () => {
    const { app, client, service } = setup([text("So you'd like to schedule automations. What would you use it for?")]);
    const conv = await start(app);
    await post(app, `/api/conversations/${conv.id}/messages`, { body: "Scheduled automations", report: "feature" }, conv.token);
    await service.idle(conv.id);
    expect(client.requests[0]!.system).toContain('This person chose "Request a feature"');
    expect(service.list(conv.id)[0]!.body).toBe("Feature request");
    expect(client.requests[0]!.system).not.toContain("search the docs for a known fix");
  });

  it("offers to file a bug that comes up, and taking the offer starts the guided report", async () => {
    const { app, client, service, tracker } = setup([
      text("Restarting the TV app usually fixes that. If it keeps happening, want me to file this as a bug?\n<offer_report>bug</offer_report>"),
      toolCall("find_tickets", { query: "clues not on TV" }),
      toolCall("add_to_ticket", { key: "ED-101", kind: "bug", note: "Clues don't show.", user_summary: "clues not showing on the TV" }),
      text("Done, it's gone straight to the team."),
    ]);
    const conv = await start(app);
    await post(app, `/api/conversations/${conv.id}/messages`, { body: "Clues aren't showing on the TV" }, conv.token);
    await service.idle(conv.id);
    expect(client.requests[0]!.system).toContain("<offer_report>bug</offer_report> or <offer_report>feature</offer_report>");
    const offered = service.list(conv.id).at(-1)!;
    expect(offered).toMatchObject({ author: "agent", offer: "bug" });
    expect(offered.body).not.toContain("offer_report");
    expect(tracker.log).toEqual({ filed: [], added: [] });

    // The widget's button sends a reply with the intent, checked like any other.
    await post(app, `/api/conversations/${conv.id}/messages`, { body: "Yes, please file it as a bug.", report: "bug" }, conv.token);
    await service.idle(conv.id);
    expect(client.requests[1]!.system).toContain('This person chose "Report a bug"');
    expect(service.list(conv.id).map((m) => m.body).slice(-4, -2)).toEqual(["Bug report", "Yes, please file it as a bug."]);
    expect(tracker.log.added).toEqual(["ED-101"]);
  });

  it("only offers what the profile has, and never without the shortcuts", async () => {
    const reply = text("Sounds like a bug. Want me to file it?\n<offer_report>feature</offer_report>");
    const bugsOnly = setup([reply]);
    const conv = await start(bugsOnly.app, { page: "/bugs" });
    await post(bugsOnly.app, `/api/conversations/${conv.id}/messages`, { body: "It's broken" }, conv.token);
    await bugsOnly.service.idle(conv.id);
    expect(bugsOnly.client.requests[0]!.system).toContain("<offer_report>bug</offer_report> on its own line");
    expect(bugsOnly.service.list(conv.id).at(-1)).not.toHaveProperty("offer");

    const none = setup([reply], { yaml: "profiles:\n  default: {}" });
    const other = await start(none.app);
    await post(none.app, `/api/conversations/${other.id}/messages`, { body: "It's broken" }, other.token);
    await none.service.idle(other.id);
    expect(none.client.requests[0]!.system).not.toContain("offer_report");
    expect(none.service.list(other.id).at(-1)).toMatchObject({ body: "Sounds like a bug. Want me to file it?" });
    expect(none.service.list(other.id).at(-1)).not.toHaveProperty("offer");
  });

  it("takes offer tags out of the reply", () => {
    expect(splitOffer("Want me to file it?\n<offer_report>bug</offer_report>", ["bug", "feature"])).toEqual({ text: "Want me to file it?", offer: "bug" });
    expect(splitOffer("File it? <offer_report> Feature ", ["feature"])).toEqual({ text: "File it?", offer: "feature" });
    expect(splitOffer("File it?<offer_report>idea</offer_report>", ["bug", "feature"])).toEqual({ text: "File it?" });
  });

  it("refuses a report the profile doesn't offer, whatever the browser sends", async () => {
    const { app, client, service } = setup([]);
    const visitor = await start(app, { signedIn: false });
    const res = await post(app, `/api/conversations/${visitor.id}/messages`, { body: "It's broken", report: "bug" }, visitor.token);
    expect(res.status).toBe(403);
    expect(service.list(visitor.id)).toEqual([]);

    // A bug-only page doesn't take feature requests, judged by the page the message comes from.
    const conv = await start(app, { page: "/bugs" });
    expect((await post(app, `/api/conversations/${conv.id}/messages`, { body: "Idea", report: "feature" }, conv.token)).status).toBe(403);
    const elsewhere = await start(app);
    expect((await post(app, `/api/conversations/${elsewhere.id}/messages`, { body: "Idea", report: "feature", context: { page: "https://app.example.com/bugs" } }, elsewhere.token)).status).toBe(403);
    expect((await post(app, `/api/conversations/${conv.id}/messages`, { body: "x", report: "ticket" }, conv.token)).status).toBe(400);
    expect(client.requests).toHaveLength(0);
  });

  it("keeps budgets and rate limits", async () => {
    const yaml = "profiles:\n  default:\n    report: both\n    budget: 0\n";
    const { app, client, service } = setup([], { yaml, maxMessages: 1 });
    const conv = await start(app);
    expect((await post(app, `/api/conversations/${conv.id}/messages`, { body: "Broken", report: "bug" }, conv.token)).status).toBe(201);
    await service.idle(conv.id);
    expect(client.requests).toHaveLength(0);
    expect(service.get(conv.id)?.status).toBe("needs_human");
    expect((await post(app, `/api/conversations/${conv.id}/messages`, { body: "Again", report: "bug" }, conv.token)).status).toBe(429);
  });
});
