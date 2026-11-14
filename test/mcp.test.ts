import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb } from "../src/db/index.js";
import { Agent } from "../src/agent/agent.js";
import { ConversationService } from "../src/conversations.js";
import { createServer, type DemoServerOptions } from "../src/server.js";
import { signUserToken, verifyUserToken } from "../src/identity.js";
import { loadConfig } from "../src/config.js";
import { parseSettings } from "../src/settings.js";
import { replaceIndex } from "../src/knowledge/index.js";
import { TicketDesk } from "../src/tickets.js";
import { DemoTracker } from "../src/demo/tracker.js";
import { demoTeamReply } from "../src/demo/index.js";
import { createTracker, demoSettings } from "../src/trackers.js";
import { createMcpServer } from "../src/mcp/server.js";
import type { TicketDraft, TrackedTicket, Tracker } from "../src/adapters/types.js";
import { FakeClient, FakeRelay } from "./helpers.js";

const SECRET = "mcp-test-secret-that-is-long-enough-12345";
const DEMO: DemoServerOptions = {
  scripted: false,
  advanceMinutes: 3,
  budget: 3,
  maxMessageLength: 500,
  maxMessagesPerConversation: 20,
  maxMessagesPerIpPerHour: 40,
  maxConversationsPerIpPerHour: 5,
};
const agentOpts = { model: "claude-haiku-5-5", effort: "low" as const, maxSteps: 6, productName: "Escape Director", productDescription: "" };
const demoYaml = fs.readFileSync("config/demo.yaml", "utf8");
const DOCS = [
  { title: "Clues", heading: "Sending a clue", url: "https://docs.example.com/clues#sending-a-clue", body: "Open the Room Dashboard and press Send Clue. The clue counter goes up by one." },
  { title: "Timers", heading: "", url: "https://docs.example.com/timers", body: "Pause and resume the room timer from the Room Dashboard." },
];

afterEach(() => vi.unstubAllGlobals());

/** The demo server, as wicketchat.com runs it, with a clock the test can move. */
function demoSetup(o: { demo?: Partial<DemoServerOptions>; yaml?: string } = {}) {
  const db = openDb(":memory:");
  replaceIndex(db, DOCS);
  let now = Date.now();
  const settings = parseSettings(o.yaml ?? demoYaml);
  const tracker = new DemoTracker(db, { advanceMs: 3 * 60_000, backlog: settings.demo!.backlog, now: () => now });
  const desk: TicketDesk = new TicketDesk(db, tracker, {
    notify: async (n) => {
      await service.ticketNews(n);
      const reply = demoTeamReply(n);
      if (reply) service.simulatedTeamReply(n.conversationId, "Alex from the team", reply);
    },
    log: () => {},
  });
  const service = new ConversationService(db, new Agent(new FakeClient([]), agentOpts), null, { settings, tickets: desk, log: () => {}, demo: true });
  const app = createServer(service, {
    allowedOrigins: [],
    maxConversationsPerIpPerHour: 50,
    maxMessagesPerConversationPerHour: 200,
    identitySecret: SECRET,
    turnstile: { siteKey: "site", secretKey: "secret", verify: async (t) => t === "good" },
    productName: "Escape Director",
    publicUrl: "https://wicketchat.com",
    demo: { ...DEMO, ...o.demo },
    mcp: { db },
  });
  return { db, app, service, desk, tracker, later: (ms: number) => (now += ms) };
}

type App = ReturnType<typeof createServer>;

/** An MCP client talking to the app over streamable HTTP, without a network. */
async function connect(app: App, token: string | null, headers: Record<string, string> = {}) {
  const transport = new StreamableHTTPClientTransport(new URL("https://wicketchat.com/mcp"), {
    requestInit: { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "x-forwarded-for": "203.0.113.7", ...headers } },
    fetch: async (url, init) => app.request(String(url), init as RequestInit),
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** A token like /api/demo/mcp-token hands out; the demo's /mcp takes no other kind. */
const sam = (sub = "demo-browser-one-abcdefghijk") => signUserToken({ sub, name: "Sam", scope: "mcp" }, SECRET, 3600);
const textOf = (r: any) => (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
const rpc = (method: string, params: object = {}) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
const initialize = rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "curl", version: "0" } });
const mcpHeaders = (token?: string) => ({ "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) });

describe("MCP auth", () => {
  it("needs a valid user token signed with IDENTITY_SECRET", async () => {
    const { app } = demoSetup();
    const missing = await app.request("/mcp", { method: "POST", headers: mcpHeaders(), body: initialize });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toMatch(/^Bearer /);

    const forged = signUserToken({ sub: "demo-someone" }, "some-other-secret-that-is-long-enough", 3600);
    const expired = signUserToken({ sub: "demo-someone" }, SECRET, 60, Date.now() - 3_600_000);
    const erase = signUserToken({ sub: "demo-someone", scope: "erase" }, SECRET, 3600);
    for (const token of [forged, expired, erase, "not-a-jwt"]) {
      const res = await app.request("/mcp", { method: "POST", headers: mcpHeaders(token), body: initialize });
      expect(res.status).toBe(401);
    }

    const good = await app.request("/mcp", { method: "POST", headers: mcpHeaders(sam()), body: initialize });
    expect(good.status).toBe(200);
    expect(((await good.json()) as any).result.serverInfo.name).toBe("wicket");
  });

  it("is stateless: GET and DELETE get a 405", async () => {
    const { app } = demoSetup();
    for (const method of ["GET", "DELETE"]) {
      const res = await app.request("/mcp", { method, headers: mcpHeaders(sam()) });
      expect(res.status).toBe(405);
    }
  });

  it("is off without IDENTITY_SECRET, since nobody could sign in", async () => {
    const db = openDb(":memory:");
    const service = new ConversationService(db, null, null, { log: () => {} });
    const app = createServer(service, { allowedOrigins: [], maxConversationsPerIpPerHour: 5, maxMessagesPerConversationPerHour: 5, mcp: { db } });
    const res = await app.request("/mcp", { method: "POST", headers: mcpHeaders(), body: initialize });
    expect(res.status).toBe(404);
  });

  it("works through the SDK's own client", async () => {
    const { app } = demoSetup();
    const client = await connect(app, sam());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["file_report", "read_doc", "search_docs", "ticket_status"]);
    await expect(connect(app, null)).rejects.toThrow();
  });
});

describe("MCP tools", () => {
  it("search_docs and read_doc answer from the docs index", async () => {
    const { app } = demoSetup();
    const client = await connect(app, sam());
    const found = await client.callTool({ name: "search_docs", arguments: { query: "how do I send a clue" } });
    expect(textOf(found)).toContain("https://docs.example.com/clues#sending-a-clue");
    expect((found.structuredContent as any).results[0].title).toBe("Clues");

    const doc = await client.callTool({ name: "read_doc", arguments: { url: "https://docs.example.com/clues#sending-a-clue" } });
    expect(textOf(doc)).toContain("clue counter goes up");
    const none = await client.callTool({ name: "read_doc", arguments: { url: "https://docs.example.com/nope" } });
    expect(none.isError).toBe(true);
  });

  it("file_report offers existing tickets first, then joins one, like the assistant does", async () => {
    const { app, service } = demoSetup();
    const client = await connect(app, sam(), { "User-Agent": "claude-code/2.1.0 (cli)" });
    const report = {
      kind: "bug",
      title: "Clue counter stuck after sending a clue",
      description: "Sent a clue from the Room Dashboard and the clue counter stayed at 2.\n\n## Steps to reproduce\n1. Open the Room Dashboard\n2. Press Send Clue",
      summary: "the clue counter not going up",
    };
    const first = await client.callTool({ name: "file_report", arguments: report });
    expect(textOf(first)).toContain("Nothing filed yet");
    expect((first.structuredContent as any).candidates[0].key).toBe("DEMO-101");
    expect(service.forUser("demo-browser-one-abcdefghijk")).toHaveLength(0);

    const joined = await client.callTool({ name: "file_report", arguments: { ...report, duplicate_of: "DEMO-101" } });
    expect(joined.isError).toBeFalsy();
    const s = joined.structuredContent as any;
    expect(s.status).toBe("added");
    expect(s.ticket.key).toBe("DEMO-101");
    expect(s.chat_url).toMatch(/^https:\/\/wicketchat\.com\/chat\/[\w-]+#/);

    // It's a conversation like any other: the user's history, a note for the team, a "logged" card.
    const [conv] = service.forUser("demo-browser-one-abcdefghijk");
    expect(conv!.id).toBe(s.report_id);
    expect(service.get(conv!.id)!.context).toEqual({ via: "mcp", client: "claude-code" });
    const msgs = service.teamMessages(conv!.id);
    expect(msgs.find((m) => m.author === "user")!.body).toContain("Clue counter stuck");
    expect(msgs.some((m) => m.author === "note" && m.body.startsWith("Added this report to DEMO-101"))).toBe(true);
    expect(msgs.some((m) => m.card?.stage === "logged")).toBe(true);

    // Reporting the same ticket again doesn't count twice.
    const again = await client.callTool({ name: "file_report", arguments: { ...report, duplicate_of: "demo-101" } });
    expect((again.structuredContent as any).status).toBe("already");
    expect(service.forUser("demo-browser-one-abcdefghijk")).toHaveLength(1);

    const missing = await client.callTool({ name: "file_report", arguments: { ...report, duplicate_of: "DEMO-999" } });
    expect(missing.isError).toBe(true);
  });

  it("files a new ticket, and ticket_status hears back when it moves", async () => {
    const { app, desk, later } = demoSetup();
    const client = await connect(app, sam());
    const filed = await client.callTool({
      name: "file_report",
      arguments: { kind: "feature", title: "Dark mode for the player screen", description: "Players want a dark player screen for rooms with low light.", summary: "a dark player screen", new_ticket: true },
    });
    const s = filed.structuredContent as any;
    expect(s.status).toBe("filed");
    expect(s.ticket.key).toBe("DEMO-1001");
    expect(s.ticket.url).toBe("https://wicketchat.com/demo#DEMO-1001");

    let status = await client.callTool({ name: "ticket_status", arguments: {} });
    expect((status.structuredContent as any).reports).toMatchObject([{ report_id: s.report_id, state: "open", ticket: { key: "DEMO-1001" } }]);

    later(4 * 60_000);
    await desk.check();
    status = await client.callTool({ name: "ticket_status", arguments: { report_id: s.report_id } });
    const [r] = (status.structuredContent as any).reports;
    expect(r.state).toBe("planned");
    expect(r.news).toContain("planning to build a dark player screen");
    expect(r.team_replies[0]).toMatchObject({ from: "Alex from the team" });
    expect(textOf(status)).toContain("DEMO-1001: Dark mode for the player screen — planned");
  });

  it("only shows a person their own reports", async () => {
    const { app } = demoSetup();
    const mine = await connect(app, sam("demo-browser-one-abcdefghijk"));
    const filed = await mine.callTool({
      name: "file_report",
      arguments: { kind: "bug", title: "Booking page shows the wrong time zone", description: "Bookings show UTC instead of the venue's time zone.", summary: "booking times in UTC", new_ticket: true },
    });
    const id = (filed.structuredContent as any).report_id;
    const theirs = await connect(app, sam("demo-browser-two-abcdefghijk"));
    const peek = await theirs.callTool({ name: "ticket_status", arguments: { report_id: id } });
    expect(peek.isError).toBe(true);
    expect(textOf(await theirs.callTool({ name: "ticket_status", arguments: {} }))).toBe("No reports yet.");
  });

  it("follows the profile's report setting", async () => {
    // Demo visitors have tickets: false. Over MCP everyone is signed in, so give the default profile report: bug.
    const bugOnly = demoYaml.replace("    report: both\n", "    report: bug\n");
    const { app } = demoSetup({ yaml: bugOnly });
    const client = await connect(app, sam());
    const tool = (await client.listTools()).tools.find((t) => t.name === "file_report")!;
    expect((tool.inputSchema.properties as any).kind.enum).toEqual(["bug"]);
    const idea = await client.callTool({ name: "file_report", arguments: { kind: "feature", title: "Export to CSV", description: "Let me export bookings to CSV.", summary: "CSV export", new_ticket: true } });
    expect(idea.isError).toBe(true);

    const none = demoSetup({ yaml: demoYaml.replace("    report: both\n", "    report: none\n") });
    const names = (await (await connect(none.app, sam())).listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("file_report");
    expect(names).toContain("search_docs");
  });

  it("shares the demo's per-IP limits with the widget", async () => {
    const { app } = demoSetup({ demo: { maxMessagesPerIpPerHour: 2, maxConversationsPerIpPerHour: 1 } });
    const client = await connect(app, sam());
    const search = () => client.callTool({ name: "search_docs", arguments: { query: "clue" } });
    expect((await search()).isError).toBeFalsy();
    expect((await search()).isError).toBeFalsy();
    const third = await search();
    expect(third.isError).toBe(true);
    expect(textOf(third)).toMatch(/Too many/);

    // Reports count like starting a chat: the widget used this IP's one chat, so no report.
    const other = demoSetup({ demo: { maxConversationsPerIpPerHour: 1 } });
    const chat = await other.app.request("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify({ userToken: sam(), turnstileToken: "good" }),
    });
    expect(chat.status).toBe(201);
    const c2 = await connect(other.app, sam());
    const report = await c2.callTool({ name: "file_report", arguments: { kind: "bug", title: "Timer resets on reload", description: "Reloading the dashboard resets the timer.", summary: "timer reset", new_ticket: true } });
    expect(report.isError).toBe(true);
    expect(textOf(report)).toMatch(/Too many reports/);
  });

  it("keeps demo queries as short as demo chat messages", async () => {
    const { app } = demoSetup({ demo: { maxMessageLength: 20 } });
    const client = await connect(app, sam());
    const long = await client.callTool({ name: "search_docs", arguments: { query: "x".repeat(21) } });
    expect(long.isError).toBe(true);
  });
});

describe("MCP in the demo can't reach a real tracker", () => {
  it("files to the demo tracker without any network call", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      calls.push(String(url));
      throw new Error("no network in the demo");
    });
    const { app, db } = demoSetup();
    const client = await connect(app, sam());
    const filed = await client.callTool({
      name: "file_report",
      arguments: { kind: "bug", title: "Hint sound plays twice", description: "The hint chime plays twice on the player screen.", summary: "double hint chime", new_ticket: true },
    });
    expect((filed.structuredContent as any).ticket.key).toMatch(/^DEMO-/);
    expect(db.$client.prepare("SELECT key FROM demo_tickets WHERE backlog = 0").all()).toEqual([{ key: "DEMO-1001" }]);
    expect(calls).toEqual([]);
  });

  it("gets the demo tracker even when real tracker keys are set", () => {
    const db = openDb(":memory:");
    const settings = parseSettings(demoYaml);
    // loadConfig refuses this; the tracker choice doesn't lean on that.
    const config = { ...loadConfig({}), DEMO: true, LINEAR_API_KEY: "lin_x", LINEAR_TEAM_KEY: "ED", GITHUB_ISSUES_REPO: "a/b", GITHUB_ISSUES_TOKEN: "t" };
    expect(createTracker(config, db, demoSettings(config, settings))!.name).toBe("demo");
    expect(createTracker({ ...config, DEMO: false, GITHUB_ISSUES_REPO: undefined }, db, demoSettings({ ...config, DEMO: false }, settings))!.name).toBe("linear");
    expect(() => loadConfig({ DEMO: "true", IDENTITY_SECRET: SECRET, TURNSTILE_SITE_KEY: "a", TURNSTILE_SECRET_KEY: "b", GITHUB_ISSUES_REPO: "a/b", GITHUB_ISSUES_TOKEN: "t" })).toThrow(
      /unset GITHUB_ISSUES_REPO, GITHUB_ISSUES_TOKEN/,
    );
  });
});

describe("demo MCP token", () => {
  it("needs the bot check, and signs in this browser's demo customer for a day", async () => {
    const { app, service } = demoSetup();
    const ask = (body: object, cookie?: string) =>
      app.request("/api/demo/mcp-token", { method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
    expect((await ask({})).status).toBe(403);
    expect((await ask({ turnstileToken: "bad" })).status).toBe(403);

    // The browser's widget sign-in, then the MCP token for the same browser.
    const widget = await app.request("/api/demo/token", { method: "POST" });
    const cookie = widget.headers.get("set-cookie")!.split(";")[0]!;
    const widgetUser = verifyUserToken(((await widget.json()) as any).token, SECRET)!;
    const res = await ask({ turnstileToken: "good" }, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; url: string; expiresAt: number };
    expect(body.url).toBe("http://localhost/mcp");
    const mcpUser = verifyUserToken(body.token, SECRET)!;
    expect(mcpUser.id).toBe(widgetUser.id);
    expect(body.expiresAt - Date.now()).toBeGreaterThan(23 * 3_600_000);

    // Reports from Claude Code land in the same person's chat history.
    const client = await connect(app, body.token);
    await client.callTool({ name: "file_report", arguments: { kind: "bug", title: "Hint sound plays twice", description: "The hint chime plays twice.", summary: "double chime", new_ticket: true } });
    expect(service.forUser(widgetUser.id)).toHaveLength(1);
  });

  it("puts a Claude Code card on /demo", async () => {
    const { app } = demoSetup();
    const html = await (await app.request("/demo")).text();
    expect(html).toContain("Try it from Claude Code");
    expect(html).toContain("/api/demo/mcp-token");
  });
});

describe("MCP over stdio", () => {
  it("names the client from the handshake and mirrors reports to the team", async () => {
    const db = openDb(":memory:");
    const relay = new FakeRelay();
    const tracker = new MemoryTracker();
    const settings = parseSettings("tickets: { assistant: true }\nprofiles:\n  default:\n    report: both\n");
    const desk = new TicketDesk(db, tracker, { notify: async () => {}, log: () => {} });
    const service = new ConversationService(db, null, relay, { settings, tickets: desk, log: () => {} });
    const identity = { id: "local:alex", name: "alex", email: null, plan: null, account: null, budget: null, env: null };
    const server = createMcpServer({ service, db, productName: "Acme" }, { identity, visitorKey: "local", allow: { call: () => true, report: () => true } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "cursor", version: "1.0.0" });
    await client.connect(b);

    // No server-side assistant is needed: the client's model gathers the details.
    const filed = await client.callTool({ name: "file_report", arguments: { kind: "bug", title: "Export button does nothing", description: "Clicking Export on the reports page does nothing.", summary: "export not working", new_ticket: true } });
    expect((filed.structuredContent as any).ticket.key).toBe("T-1");
    expect(tracker.created[0]!.description).toContain("Reported by alex from cursor");
    const [thread] = relay.threads.values();
    expect(thread!.posts[0]).toContain("Export button does nothing");
    expect(thread!.posts).toContain("system: 🐞 Sent from cursor");
  });
});

/** A tracker kept in memory, with search, for the stdio test. */
class MemoryTracker implements Tracker {
  name = "memory";
  created: TicketDraft[] = [];
  searchFails = false;
  createFails = false;
  async create(t: TicketDraft) {
    if (this.createFails) throw new Error("tracker is down");
    this.created.push(t);
    const key = `T-${this.created.length}`;
    return { id: key, key, url: `https://tracker.example.com/${key}` };
  }
  async search(): Promise<TrackedTicket[]> {
    if (this.searchFails) throw new Error("search is down");
    return [];
  }
}

/** A real install: a tracker that can be made to fail, and the team's Discord. */
function installSetup(o: { maxConversationsPerIpPerHour?: number; maxMessagesPerConversationPerHour?: number } = {}) {
  const db = openDb(":memory:");
  replaceIndex(db, DOCS);
  const relay = new FakeRelay();
  const tracker = new MemoryTracker();
  const settings = parseSettings("tickets: { assistant: true }\nprofiles:\n  default:\n    report: both\n");
  const desk = new TicketDesk(db, tracker, { notify: (n) => service.ticketNews(n), log: () => {} });
  const service = new ConversationService(db, null, relay, { settings, tickets: desk, log: () => {} });
  const app = createServer(service, {
    allowedOrigins: [],
    maxConversationsPerIpPerHour: o.maxConversationsPerIpPerHour ?? 50,
    maxMessagesPerConversationPerHour: o.maxMessagesPerConversationPerHour ?? 200,
    identitySecret: SECRET,
    productName: "Acme",
    publicUrl: "https://support.acme.test",
    mcp: { db },
  });
  return { db, app, service, desk, tracker, relay };
}
const user = (sub: string) => signUserToken({ sub, name: sub }, SECRET, 3600);
const bug = (title: string, extra: object = {}) => ({ kind: "bug", title, description: `${title}, every time.`, summary: title.toLowerCase(), ...extra });

describe("review fixes", () => {
  it("won't join a ticket the report wasn't offered, so nobody learns another visitor's ticket", async () => {
    const { app, db } = demoSetup();
    const alice = await connect(app, sam("demo-alice-abcdefghijklmnop"));
    await alice.callTool({ name: "file_report", arguments: bug("Lantern puzzle won't reset", { new_ticket: true }) });
    const bob = await connect(app, sam("demo-bob-abcdefghijklmnopqr"), { "x-forwarded-for": "198.51.100.9" });
    const peek = await bob.callTool({ name: "file_report", arguments: bug("Something else entirely", { duplicate_of: "DEMO-1001" }) });
    expect(peek.isError).toBe(true);
    expect(textOf(peek)).not.toContain("Lantern");
    // A backlog ticket that search didn't offer for this report is refused too.
    const offTopic = await bob.callTool({ name: "file_report", arguments: bug("Clue counter stuck after sending a clue", { duplicate_of: "DEMO-103" }) });
    expect(offTopic.isError).toBe(true);
    expect(db.$client.prepare("SELECT key, touched_at IS NOT NULL AS touched FROM demo_tickets WHERE key IN ('DEMO-1001','DEMO-103') ORDER BY key").all()).toEqual([
      { key: "DEMO-1001", touched: 1 },
      { key: "DEMO-103", touched: 0 },
    ]);
    // Alice can still add to her own ticket from a new report.
    const own = await alice.callTool({ name: "file_report", arguments: bug("Lantern puzzle stuck again", { duplicate_of: "DEMO-1001" }) });
    expect((own.structuredContent as any).status).toBe("already");
  });

  it("won't open the demo's /mcp with the widget's token, which comes without a bot check", async () => {
    const { app } = demoSetup();
    const widget = (await (await app.request("/api/demo/token", { method: "POST" })).json()) as { token: string };
    const res = await app.request("/mcp", { method: "POST", headers: mcpHeaders(widget.token), body: initialize });
    expect(res.status).toBe(401);
  });

  it("doesn't let a demo report's chat token get assistant answers without a bot check", async () => {
    const { app, service } = demoSetup();
    const client = await connect(app, sam());
    const filed = await client.callTool({ name: "file_report", arguments: bug("Hint sound plays twice", { new_ticket: true }) });
    const conv = service.get((filed.structuredContent as any).report_id)!;
    const res = await app.request(`/api/conversations/${conv.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${conv.token}` },
      body: JSON.stringify({ body: "How do I add a clue?" }),
    });
    expect(res.status).toBe(201);
    await service.idle(conv.id);
    // The FakeClient has no answers queued, so an assistant call would have failed and said sorry.
    const after = service.list(conv.id).map((m) => m.author);
    expect(after).not.toContain("agent");
  });

  it("files nothing when the duplicate check fails", async () => {
    const { app, tracker, service } = installSetup();
    tracker.searchFails = true;
    const client = await connect(app, user("u1"));
    const res = await client.callTool({ name: "file_report", arguments: bug("Export button does nothing") });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/nothing was filed/);
    expect(tracker.created).toHaveLength(0);
    expect(service.forUser("u1")).toHaveLength(0);
  });

  it("leaves no conversation or Discord thread behind when the tracker is down", async () => {
    const { app, tracker, service, relay } = installSetup();
    tracker.createFails = true;
    const client = await connect(app, user("u1"));
    const res = await client.callTool({ name: "file_report", arguments: bug("Export button does nothing", { new_ticket: true }) });
    expect(res.isError).toBe(true);
    expect(service.forUser("u1")).toHaveLength(0);
    expect(relay.threads.size).toBe(0);

    tracker.createFails = false;
    const ok = await client.callTool({ name: "file_report", arguments: bug("Export button does nothing", { new_ticket: true }) });
    expect((ok.structuredContent as any).ticket.key).toBe("T-1");
    const [thread] = relay.threads.values();
    expect(thread!.posts[0]).toContain("Export button does nothing");
    expect(thread!.posts.some((p) => p.includes("Filed [T-1]"))).toBe(true);
  });

  it("limits reports per person, not just per X-Forwarded-For", async () => {
    const { app, tracker } = installSetup({ maxConversationsPerIpPerHour: 2 });
    let filed = 0;
    for (let i = 0; i < 5; i++) {
      const client = await connect(app, user("u1"), { "x-forwarded-for": `203.0.113.${i}` });
      const res = await client.callTool({ name: "file_report", arguments: bug(`Report number ${i}`, { new_ticket: true }) });
      if (!res.isError) filed++;
    }
    expect(filed).toBe(2);
    expect(tracker.created).toHaveLength(2);
  });

  it("limits tool calls per person outside the demo", async () => {
    const { app } = installSetup({ maxMessagesPerConversationPerHour: 2 });
    const client = await connect(app, user("u1"));
    const search = () => client.callTool({ name: "search_docs", arguments: { query: "clue" } });
    expect((await search()).isError).toBeFalsy();
    expect((await search()).isError).toBeFalsy();
    expect((await search()).isError).toBe(true);
    // Someone else has their own allowance.
    const other = await connect(app, user("u2"));
    expect((await other.callTool({ name: "search_docs", arguments: { query: "clue" } })).isError).toBeFalsy();
  });

  it("finds a report by id however old it is", async () => {
    const { app, service } = installSetup();
    const client = await connect(app, user("u1"));
    const first = await client.callTool({ name: "file_report", arguments: bug("Old report from long ago", { new_ticket: true }) });
    const id = (first.structuredContent as any).report_id;
    const identity = verifyUserToken(user("u1"), SECRET)!;
    for (let i = 0; i < 55; i++) service.create({}, undefined, { identity, visitorKey: "x" });
    const status = await client.callTool({ name: "ticket_status", arguments: { report_id: id } });
    expect(status.isError).toBeFalsy();
    expect((status.structuredContent as any).reports[0].ticket.title).toBe("Old report from long ago");
  });

  it("gives each ticket in a conversation its own state", async () => {
    const { app, service, desk } = installSetup();
    const identity = verifyUserToken(user("u1"), SECRET)!;
    const conv = service.create({}, undefined, { identity, visitorKey: "x" });
    await desk.file({ title: "Timer drifts", kind: "bug", description: "d" }, { conversationId: conv.id, summary: "the timer drifting" });
    await desk.file({ title: "CSV export", kind: "feature", description: "d" }, { conversationId: conv.id, summary: "exporting to CSV" });
    await service.ticketNews({ stage: "planned", conversationId: conv.id, key: "T-2", title: "CSV export", kind: "feature", summary: "exporting to CSV", reportedAt: Date.now() });
    const client = await connect(app, user("u1"));
    const { reports } = (await client.callTool({ name: "ticket_status", arguments: {} })).structuredContent as any;
    const byKey = Object.fromEntries(reports.map((r: any) => [r.ticket.key, r]));
    expect(byKey["T-1"]).toMatchObject({ state: "open", news: null });
    expect(byKey["T-2"].state).toBe("planned");
  });

  it("answers CORS preflight for browser-based clients", async () => {
    const { app } = installSetup();
    const res = await app.request("/mcp", {
      method: "OPTIONS",
      headers: { Origin: "https://inspector.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type, mcp-protocol-version" },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
  });

  it("caps demo report descriptions like demo chat messages", async () => {
    const { app } = demoSetup({ demo: { maxMessageLength: 40 } });
    const client = await connect(app, sam());
    const long = await client.callTool({ name: "file_report", arguments: { ...bug("Hint sound plays twice", { new_ticket: true }), description: "x".repeat(41) } });
    expect(long.isError).toBe(true);
  });
});

describe("the stdio entry", () => {
  const stdioEnv = (extra: Record<string, string> = {}) => ({
    PATH: process.env.PATH ?? "",
    DATABASE_PATH: ":memory:",
    WICKET_CONFIG: "tickets: { assistant: true }",
    IDENTITY_SECRET: SECRET,
    ...extra,
  });
  const spawn = async (env: Record<string, string>) => {
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp/stdio.ts"], env, stderr: "pipe" }));
    return client;
  };

  it("serves the tools over stdio, with nothing but protocol on stdout", async () => {
    const client = await spawn(stdioEnv());
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    // No tracker set up, so no file_report.
    expect(names).toEqual(["read_doc", "search_docs", "ticket_status"]);
    await client.close();
  }, 20_000);

  it("refuses a bad WICKET_USER_TOKEN instead of acting as the local user", async () => {
    await expect(spawn(stdioEnv({ WICKET_USER_TOKEN: "not-a-token" }))).rejects.toThrow();
  }, 20_000);
});
