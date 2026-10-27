import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { Agent, splitFollowUps } from "../src/agent/agent.js";
import { ConversationService, MESSAGES } from "../src/conversations.js";
import { createServer } from "../src/server.js";
import { signUserToken } from "../src/identity.js";
import { parseSettings } from "../src/settings.js";
import { FakeClient, FakeRelay } from "./helpers.js";

const SECRET = "test-secret-that-is-long-enough-1234567890";
const agentOpts = { model: "claude-haiku-5-5", effort: "low" as const, maxSteps: 4, productName: "Escape Director", productDescription: "" };

const usage = (input: number, output = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
const reply = (t: string, input = 1000) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn", usage: usage(input) });
const call = (name: string, input: object) => ({ content: [{ type: "tool_use", id: `tu_${name}`, name, input }], stop_reason: "tool_use", usage: usage(1000) });

const SETTINGS = `
profiles:
  visitor:
    budget: 0.5
    budgetScope: shared
    botCheck: true
    tickets: false
  default:
    followUps: true
    appTools:
      url:
        production: https://app.example.com/tools
        staging: https://staging.example.com/tools
rules:
  - when: { signedIn: false }
    profile: visitor
`;

/** A host app with one tool, recording what Wicket sent it. */
function fakeHost() {
  const calls: { url: string; auth: string | null; body: any }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("Authorization");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, auth, body });
    if (!init?.method || init.method === "GET") {
      return Response.json({
        instructions: "Cite figures by their E-number.",
        tools: [{ name: "get_success_rate", description: "Success Rate for a Room", inputSchema: { type: "object", properties: { roomName: { type: "string" } } } }],
      });
    }
    const n = body.evidenceStart + 1;
    return Response.json({
      content: { evidenceId: `E${n}`, value: "62%" },
      evidence: [{ id: `E${n}`, label: "Success Rate · Cabin 13", value: "62%", period: "Sep 1 – Sep 30", basis: "48 games" }],
    });
  }) as typeof fetch;
  return { calls, impl };
}

function setup(responses: any[], opts: { verify?: (t: string) => Promise<boolean> } = {}) {
  const db = openDb(":memory:");
  const client = new FakeClient(responses);
  const relay = new FakeRelay();
  const host = fakeHost();
  const service = new ConversationService(db, new Agent(client, agentOpts), relay, { settings: parseSettings(SETTINGS), log: () => {}, fetch: host.impl });
  void relay.start(async () => {});
  const app = createServer(service, {
    allowedOrigins: [],
    maxConversationsPerIpPerHour: 50,
    maxMessagesPerConversationPerHour: 50,
    identitySecret: SECRET,
    turnstile: { siteKey: "site-key", secretKey: "secret", verify: opts.verify ?? (async (t) => t === "good") },
  });
  return { client, relay, service, app, host };
}

const post = (app: ReturnType<typeof createServer>, path: string, body: unknown, token?: string) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const tokenFor = (claims: { sub?: string; account?: string; budget?: number; env?: string } = {}) =>
  signUserToken({ sub: "u1", name: "Sam", account: "acct1", budget: 3, ...claims }, SECRET);

async function start(app: ReturnType<typeof createServer>, userToken?: string, extra: object = {}) {
  const res = await post(app, "/api/conversations", { userToken, context: { path: "/app/rooms/r1", roomId: "r1" }, ...extra });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; token: string };
}

describe("app tools", () => {
  it("calls the host's tools as the person, with the page context, and keeps the evidence", async () => {
    const { app, client, service, host } = setup([
      call("get_success_rate", { roomName: "Cabin 13" }),
      reply("Cabin 13 escapes 62% of the time [E1].\n<ask_next>\nHow does it compare with last month?\n- Which Puzzle takes longest?\n</ask_next>"),
    ]);
    const first = tokenFor();
    const conv = await start(app, first);
    const fresh = tokenFor({ budget: 6 });
    await post(app, `/api/conversations/${conv.id}/messages`, { body: "How is this Room doing?", userToken: fresh }, conv.token);
    await service.idle(conv.id);

    // The newest token is the one the host sees, on both the list and the call.
    expect(host.calls.map((c) => [c.url.split("?")[0], c.auth])).toEqual([
      ["https://app.example.com/tools", `Bearer ${fresh}`],
      ["https://app.example.com/tools/get_success_rate", `Bearer ${fresh}`],
    ]);
    expect(host.calls[1]!.body).toEqual({ input: { roomName: "Cabin 13" }, context: { path: "/app/rooms/r1", roomId: "r1" }, evidenceStart: 0 });
    expect(client.requests[0].tools.map((t: any) => t.name)).toContain("get_success_rate");
    expect(client.requests[0].system).toContain("Cite figures by their E-number.");
    expect(client.requests[0].system).toContain("<ask_next>");

    const answer = service.list(conv.id).at(-1)!;
    expect(answer).toMatchObject({
      author: "agent",
      body: "Cabin 13 escapes 62% of the time [E1].",
      evidence: [{ id: "E1", value: "62%", basis: "48 games" }],
      followUps: ["How does it compare with last month?", "Which Puzzle takes longest?"],
      rating: null,
    });
    // The fresh token raised the account's allowance.
    expect(service.get(conv.id)?.budgetMicros).toBe(6_000_000);
  });

  it("picks the host environment from the token, and answers without tools when there's no URL for it", async () => {
    const { app, service, host } = setup([reply("Hi."), reply("Hello.")]);
    const staging = await start(app, tokenFor({ env: "staging" }));
    await post(app, `/api/conversations/${staging.id}/messages`, { body: "hi" }, staging.token);
    await service.idle(staging.id);
    expect(host.calls[0]!.url).toMatch(/^https:\/\/staging\.example\.com\/tools\?/);

    const other = await start(app, tokenFor({ env: "preview" }));
    await post(app, `/api/conversations/${other.id}/messages`, { body: "hi" }, other.token);
    await service.idle(other.id);
    expect(host.calls).toHaveLength(1);
  });

  it("sends the page context again only when it changed", async () => {
    const { app, client, service } = setup([reply("a"), reply("b"), reply("c")]);
    const conv = await start(app, tokenFor());
    const ctxText = (i: number) => client.requests[i].messages.at(-1).content.some((b: any) => b.type === "text" && b.text?.startsWith("<app_context>"));
    await post(app, `/api/conversations/${conv.id}/messages`, { body: "1" }, conv.token);
    await service.idle(conv.id);
    await post(app, `/api/conversations/${conv.id}/messages`, { body: "2", context: { path: "/app/rooms/r1", roomId: "r1" } }, conv.token);
    await service.idle(conv.id);
    await post(app, `/api/conversations/${conv.id}/messages`, { body: "3", context: { path: "/app/analytics", roomId: null } }, conv.token);
    await service.idle(conv.id);
    expect([ctxText(0), ctxText(1), ctxText(2)]).toEqual([true, false, true]);
  });
});

describe("account budgets", () => {
  it("counts everyone on an account toward the allowance in their token", async () => {
    // Haiku 5.5: 1M input tokens = $0.10, so each answer costs $1.50 against a $3 allowance.
    const { app, client, service } = setup([reply("One.", 15_000_000), reply("Two.", 15_000_000), reply("Three.")]);
    const a = await start(app, tokenFor({ sub: "u1" }));
    await post(app, `/api/conversations/${a.id}/messages`, { body: "a" }, a.token);
    await service.idle(a.id);
    const b = await start(app, tokenFor({ sub: "u2" }));
    await post(app, `/api/conversations/${b.id}/messages`, { body: "b" }, b.token);
    await service.idle(b.id);
    await post(app, `/api/conversations/${b.id}/messages`, { body: "c" }, b.token);
    await service.idle(b.id);

    expect(client.requests).toHaveLength(2);
    expect(service.ledger.spentThisMonth("account:acct1")).toBe(3_000_000);
    expect(service.list(b.id).at(-1)?.body).toBe(MESSAGES.overBudget);
  });
});

describe("visitors", () => {
  it("must pass the bot check, then share one pot, and can't log reports", async () => {
    const { app, client, service } = setup([reply("Sure.", 5_000_000), reply("never")]);
    const session = await (await post(app, "/api/session", {})).json();
    expect(session.botCheck).toEqual({ siteKey: "site-key" });

    const refused = await post(app, "/api/conversations", { turnstileToken: "bad" });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ botCheck: true });

    const one = await start(app, undefined, { turnstileToken: "good" });
    await post(app, `/api/conversations/${one.id}/messages`, { body: "hi" }, one.token);
    await service.idle(one.id);
    expect(client.requests[0].tools.map((t: any) => t.name)).not.toContain("file_ticket");

    // Another visitor (another IP) draws on the same pot, which the first one spent.
    const two = await start(app, undefined, { turnstileToken: "good" });
    await post(app, `/api/conversations/${two.id}/messages`, { body: "hi" }, two.token);
    await service.idle(two.id);
    expect(client.requests).toHaveLength(1);
    expect(service.ledger.spentThisMonth("shared:visitor")).toBe(500_000);
  });
});

describe("ratings", () => {
  it("saves a thumbs up or down, tells the team, and hands off on request", async () => {
    const { app, service, relay } = setup([reply("Try restarting the Room Station.")]);
    const conv = await start(app, tokenFor());
    await post(app, `/api/conversations/${conv.id}/messages`, { body: "It froze" }, conv.token);
    await service.idle(conv.id);
    const answer = service.list(conv.id).at(-1)!;

    expect((await post(app, `/api/conversations/${conv.id}/messages/${answer.id}/rating`, { rating: "down" }, conv.token)).status).toBe(200);
    expect(service.list(conv.id).at(-1)?.rating).toBe("down");
    expect([...relay.threads.values()][0]!.posts.at(-1)).toContain("👎 Rated this answer");
    // Someone else's conversation token can't rate it.
    expect((await post(app, `/api/conversations/${conv.id}/messages/${answer.id}/rating`, { rating: "up" }, "nope")).status).toBe(404);

    expect((await post(app, `/api/conversations/${conv.id}/handoff`, {}, conv.token)).status).toBe(200);
    expect(service.get(conv.id)?.status).toBe("needs_human");
    expect(service.list(conv.id).slice(-2).map((m) => m.body)).toEqual([MESSAGES.askedForPerson, MESSAGES.waiting()]);
  });
});

describe("follow-ups", () => {
  it("takes the block off the reply, even when the model leaves it open", () => {
    expect(splitFollowUps("Done.\n<ask_next>\n1. One?\n2. Two?\n</ask_next>")).toEqual({ text: "Done.", followUps: ["One?", "Two?"] });
    expect(splitFollowUps("Done.\n<ask_next>\n- A?")).toEqual({ text: "Done.", followUps: ["A?"] });
    expect(splitFollowUps("Done.\n<ask_next>\n- A?\n</ask_next>\n<ask_next>\n- A?\n- B?\n</ask_next>")).toEqual({ text: "Done.", followUps: ["A?", "B?"] });
    expect(splitFollowUps("No block.")).toEqual({ text: "No block.", followUps: [] });
  });
});
