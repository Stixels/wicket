import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { Agent, systemPrompt } from "../src/agent/agent.js";
import { ConversationService, MESSAGES } from "../src/conversations.js";
import { createServer } from "../src/server.js";
import { signUserToken, verifyUserToken } from "../src/identity.js";
import { parseSettings, pathMatches, resolveProfile } from "../src/settings.js";
import { costMicros, priceFor } from "../src/usage.js";
import { FakeClient, FakeRelay } from "./helpers.js";

const SECRET = "test-secret-that-is-long-enough-1234567890";
const agentOpts = { model: "claude-haiku-5-5", effort: "low" as const, maxSteps: 4, productName: "Escape Director", productDescription: "" };

const SETTINGS = `
profiles:
  visitor:
    ai: false
    askEmail: true
    welcomeSubtitle: Send us a message
  support:
    instructions: Keep it short.
    budget: 0.5
  analytics:
    instructions: Answer with numbers.
    model: claude-sonnet-5-5
    budget: 2
rules:
  - when: { signedIn: false }
    profile: visitor
  - when: { page: /app/analytics, plan: pro }
    profile: analytics
  - profile: support
`;

/** A reply that reports token usage, like the real API. */
const reply = (t: string, input = 1000, output = 200) => ({
  content: [{ type: "text", text: t }],
  stop_reason: "end_turn",
  usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

function setup(responses: any[], settingsYaml = SETTINGS) {
  const db = openDb(":memory:");
  const client = new FakeClient(responses);
  const relay = new FakeRelay();
  const service = new ConversationService(db, new Agent(client, agentOpts), relay, { settings: parseSettings(settingsYaml), log: () => {} });
  void relay.start(async () => {});
  const app = createServer(service, { allowedOrigins: [], maxConversationsPerIpPerHour: 50, maxMessagesPerConversationPerHour: 50, identitySecret: SECRET });
  return { client, relay, service, app };
}

async function post(app: ReturnType<typeof createServer>, path: string, body: unknown, token?: string) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function start(app: ReturnType<typeof createServer>, opts: { plan?: string; page?: string; signedIn?: boolean } = {}) {
  const userToken = opts.signedIn === false ? undefined : signUserToken({ sub: "u1", name: "Sam", email: "sam@example.com", ...(opts.plan ? { plan: opts.plan } : {}) }, SECRET);
  const res = await post(app, "/api/conversations", { userToken, context: { page: `https://app.example.com${opts.page ?? "/app/rooms"}` } });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; token: string };
}

describe("settings", () => {
  it("matches pages, plans and sign-in in rule order", () => {
    const s = parseSettings(SETTINGS);
    expect(resolveProfile(s, { signedIn: false, plan: "pro", path: "/app/analytics" }).name).toBe("visitor");
    expect(resolveProfile(s, { signedIn: true, plan: "pro", path: "/app/analytics/rooms" }).name).toBe("analytics");
    expect(resolveProfile(s, { signedIn: true, plan: "free", path: "/app/analytics" }).name).toBe("support");
    expect(resolveProfile(s, { signedIn: true, plan: null, path: null }).name).toBe("support");
  });

  it("matches a path and everything below it, or a wildcard", () => {
    expect(pathMatches("/app/analytics", "/app/analytics")).toBe(true);
    expect(pathMatches("/app/analytics", "/app/analytics/")).toBe(true);
    expect(pathMatches("/app/analytics", "/app/analytics/x")).toBe(true);
    expect(pathMatches("/app/analytics", "/app/analyticsx")).toBe(false);
    expect(pathMatches("/app/*/settings", "/app/rooms/settings")).toBe(true);
    expect(pathMatches("/", "/anything")).toBe(true);
  });

  it("with no settings, everyone gets the assistant", () => {
    const p = resolveProfile(parseSettings(""), { signedIn: false, plan: null, path: "/" });
    expect(p).toMatchObject({ name: "default", ai: true });
  });

  it("leaves the public help forum to people unless turned on", () => {
    expect(parseSettings("").assistant.helpForum).toBe(false);
    expect(parseSettings("assistant:\n  code: decline").assistant.helpForum).toBe(false);
    expect(parseSettings("assistant:\n  helpForum: true").assistant.helpForum).toBe(true);
  });

  it("explains mistakes", () => {
    expect(() => parseSettings("rules:\n  - profile: nope")).toThrow(/profile "nope"/);
    expect(() => parseSettings("profiles:\n  a:\n    budjet: 2")).toThrow(/profiles\.a/);
  });
});

describe("user tokens", () => {
  it("accepts a valid token and rejects tampered, expired or unsigned ones", () => {
    const token = signUserToken({ sub: "42", plan: "pro" }, SECRET);
    expect(verifyUserToken(token, SECRET)).toEqual({ id: "42", name: null, email: null, plan: "pro", account: null, budget: null, env: null });
    expect(verifyUserToken(token, "another-secret-that-is-long-enough-12345")).toBeNull();
    const [h, , sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "42", plan: "enterprise" })).toString("base64url");
    expect(verifyUserToken(`${h}.${forged}.${sig}`, SECRET)).toBeNull();
    expect(verifyUserToken(signUserToken({ sub: "42" }, SECRET, 60, Date.now() - 3_600_000), SECRET)).toBeNull();
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"sub":"42"}').toString("base64url")}.`;
    expect(verifyUserToken(none, SECRET)).toBeNull();
    expect(verifyUserToken(token, undefined)).toBeNull();
  });

  it("rejects tokens with no expiry or one too far out", () => {
    const sign = (claims: object) => {
      const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const body = `${enc({ alg: "HS256", typ: "JWT" })}.${enc(claims)}`;
      return `${body}.${crypto.createHmac("sha256", SECRET).update(body).digest("base64url")}`;
    };
    const now = Math.floor(Date.now() / 1000);
    expect(verifyUserToken(sign({ sub: "42" }), SECRET)).toBeNull();
    expect(verifyUserToken(sign({ sub: "42", exp: now + 30 * 86_400 }), SECRET)).toBeNull();
    expect(verifyUserToken(sign({ sub: "42", exp: now + 3600 }), SECRET)?.id).toBe("42");
    expect(verifyUserToken(signUserToken({ sub: "42" }, SECRET, 2 * 86_400), SECRET)).toBeNull();
  });
});

describe("profiles in conversations", () => {
  it("sends visitors straight to the team without calling the model", async () => {
    const { app, client, relay, service } = setup([]);
    const conv = await start(app, { signedIn: false });
    await post(app, `/api/conversations/${conv.id}/messages`, { body: "Is there a free trial?" }, conv.token);
    await service.idle(conv.id);
    await post(app, `/api/conversations/${conv.id}/messages`, { body: "Hello?" }, conv.token);
    await service.idle(conv.id);

    expect(client.requests).toHaveLength(0);
    expect(relay.humanRequests).toHaveLength(1);
    expect(service.list(conv.id).map((m) => `${m.author}: ${m.body}`)).toEqual([
      "user: Is there a free trial?",
      `system: ${MESSAGES.waiting()}`,
      "user: Hello?",
    ]);

    // They can leave an email, which the team sees in the thread.
    expect((await post(app, `/api/conversations/${conv.id}/email`, { email: "not an email" }, conv.token)).status).toBe(400);
    expect((await post(app, `/api/conversations/${conv.id}/email`, { email: "pat@example.com" }, conv.token)).status).toBe(200);
    expect(service.get(conv.id)?.reporterEmail).toBe("pat@example.com");
    expect([...relay.threads.values()][0]!.posts.at(-1)).toBe("system: Email for follow-up: pat@example.com");
  });

  it("does not trust a user id from the browser without a valid token", async () => {
    const { app } = setup([]);
    const res = await post(app, "/api/conversations", { reporter: { id: "u1" }, userToken: "bogus.token.here" });
    expect(res.status).toBe(401);
    const session = await (await post(app, "/api/session", { context: { page: "https://x/app" } })).json();
    expect(session).toMatchObject({ profile: "visitor", ai: false, signedIn: false, askEmail: true, ui: { welcomeSubtitle: "Send us a message" } });
  });

  it("uses the page and plan to pick instructions and model", async () => {
    const { app, client, service } = setup([reply("Your escape rate is 62%.")]);
    const conv = await start(app, { plan: "pro", page: "/app/analytics" });
    await post(app, `/api/conversations/${conv.id}/messages`, { body: "How am I doing?", context: { page: "https://app.example.com/app/analytics" } }, conv.token);
    await service.idle(conv.id);

    expect(client.requests[0].model).toBe("claude-sonnet-5-5");
    expect(client.requests[0].system[0].text).toContain("Answer with numbers.");
    const session = await (
      await post(app, "/api/session", { userToken: signUserToken({ sub: "u1", plan: "pro" }, SECRET), context: { page: "https://app.example.com/app/analytics" } })
    ).json();
    expect(session).toMatchObject({ profile: "analytics", ai: true, signedIn: true, askEmail: false });
  });

  it("warns near the budget, then hands the person to the team once it's spent", async () => {
    // Haiku 5.5: 1M input tokens = $0.10. Each reply here costs $0.20, against a $0.50 budget.
    const big = (t: string) => reply(t, 2_000_000, 0);
    const { app, client, relay, service } = setup([big("One."), big("Two."), big("Three.")]);
    const conv = await start(app);
    for (const body of ["a", "b", "c", "d"]) {
      await post(app, `/api/conversations/${conv.id}/messages`, { body }, conv.token);
      await service.idle(conv.id);
    }

    expect(client.requests).toHaveLength(3);
    expect(service.ledger.spentThisMonth("user:u1")).toBe(600_000);
    const lines = service.list(conv.id).map((m) => `${m.author}: ${m.body}`);
    expect(lines).toEqual([
      "user: a",
      "agent: One.",
      "user: b",
      "agent: Two.",
      `system: ${MESSAGES.nearBudget}`,
      "user: c",
      "agent: Three.",
      "user: d",
      `system: ${MESSAGES.overBudget}`,
    ]);
    expect(relay.humanRequests.at(-1)).toContain("monthly assistant budget");

    // The budget belongs to the person, so a new conversation doesn't reset it.
    const again = await start(app);
    await post(app, `/api/conversations/${again.id}/messages`, { body: "e" }, again.token);
    await service.idle(again.id);
    expect(client.requests).toHaveLength(3);
  });

  it("stops the assistant for everyone at the monthly total", async () => {
    const { app, client, service } = setup([reply("Sure.", 6_000_000, 0)], "budgets:\n  monthlyTotal: 0.5\n");
    const a = await start(app, { signedIn: false });
    await post(app, `/api/conversations/${a.id}/messages`, { body: "hi" }, a.token);
    await service.idle(a.id);
    const b = await start(app, { signedIn: false });
    await post(app, `/api/conversations/${b.id}/messages`, { body: "hi" }, b.token);
    await service.idle(b.id);
    expect(client.requests).toHaveLength(1);
    expect(service.list(b.id).at(-1)?.body).toBe(MESSAGES.overTotal);
  });
});

describe("pricing", () => {
  it("knows gateway and plain model ids, and counts unknown models high", () => {
    expect(priceFor("anthropic/claude-haiku-5.5")).toEqual(priceFor("claude-haiku-5-5"));
    expect(priceFor("openai/gpt-6-luna")?.input).toBe(0.1);
    expect(costMicros({ model: "claude-haiku-5-5", input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 })).toBe(600_000);
    expect(costMicros({ model: "mystery-model", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(5_000_000);
    expect(costMicros({ model: "mystery-model", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, { "mystery-model": { input: 1, output: 2 } })).toBe(1_000_000);
  });
});

describe("staying on topic", () => {
  it("tells the assistant to decline unrelated requests unless a profile allows them", async () => {
    const yaml = "profiles:\n  default: {}\n  open:\n    offTopic: allow\n  wider:\n    topics: running an escape room business\nrules:\n  - when: { page: /open }\n    profile: open\n  - when: { page: /wider }\n    profile: wider\n";
    const { app, client, service } = setup([reply("a"), reply("b"), reply("c")], yaml);
    for (const page of ["/app", "/open", "/wider"]) {
      const conv = await start(app, { page });
      await post(app, `/api/conversations/${conv.id}/messages`, { body: "Write me tic tac toe in Python" }, conv.token);
      await service.idle(conv.id);
    }
    const [def, open, wider] = client.requests.map((r: any) => r.system[0].text as string);
    expect(def).toContain("Only help with Escape Director.");
    expect(open).not.toContain("Only help with");
    expect(wider).toContain("Only help with Escape Director and running an escape room business.");
  });
});

describe("code and team notes", () => {
  const base = { productName: "Escape Director", productDescription: "" };

  it("declines to write code by default, and allows snippets when configured", () => {
    expect(systemPrompt(base)).toContain("you're not set up to write code here");
    const snippets = systemPrompt({ ...base, code: "snippets" });
    expect(snippets).toContain("Keep it to a short snippet");
    expect(snippets).not.toContain("not set up to write code");
    expect(parseSettings("profiles: {}").assistant.code).toBe("decline");
  });

  it("adds the team's notes to every conversation", () => {
    const settings = parseSettings("assistant:\n  instructions: Any MQTT device works through Connect Existing Devices.\n");
    const prompt = systemPrompt({ ...base, instructions: settings.assistant.instructions }, "On the Analytics page.");
    expect(prompt).toContain("Notes from the Escape Director team:\nAny MQTT device works through Connect Existing Devices.");
    expect(prompt.indexOf("Notes from")).toBeLessThan(prompt.indexOf("On the Analytics page."));
  });
});
