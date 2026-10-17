import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { Agent } from "../src/agent/agent.js";
import { ConversationService, MESSAGES, sanitizeContext } from "../src/conversations.js";
import { replaceIndex } from "../src/knowledge/index.js";
import { createServer, RateLimiter } from "../src/server.js";
import { FakeClient, FakeRelay, text, toolCall } from "./helpers.js";

const agentOpts = { model: "claude-opus-5-5", effort: "low" as const, maxSteps: 4, productName: "Escape Director", productDescription: "" };

function setup(responses: ConstructorParameters<typeof FakeClient>[0]) {
  const db = openDb(":memory:");
  replaceIndex(db, [
    { title: "Configure Live View", heading: "Add a timer", url: "https://docs/live-view#add-a-timer", body: "Open Live View settings and add a timer widget." },
  ]);
  const client = new FakeClient(responses);
  const relay = new FakeRelay();
  const service = new ConversationService(db, new Agent(client, agentOpts), relay, () => {});
  void relay.start(
    ({ threadId, authorName, body }) => service.handleStaffReply(threadId, authorName, body),
    (threadId, deleted) => service.resolve(threadId, deleted),
  );
  const app = createServer(service, { allowedOrigins: [], maxConversationsPerIpPerHour: 5, maxMessagesPerConversationPerHour: 30 });
  return { db, client, relay, service, app };
}

async function startConversation(app: ReturnType<typeof createServer>) {
  const res = await app.request("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reporter: { id: "u1", name: "Sam" }, context: { appVersion: "1.4.2", page: "/rooms/7" } }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; token: string };
}

async function send(app: ReturnType<typeof createServer>, conv: { id: string; token: string }, body: string) {
  return app.request(`/api/conversations/${conv.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${conv.token}` },
    body: JSON.stringify({ body }),
  });
}

describe("conversation flow", () => {
  it("answers from the docs, mirrors to the relay and keeps the transcript replayable", async () => {
    const { app, client, relay, service } = setup([
      toolCall("search_docs", { query: "add timer live view" }),
      text("Open Live View settings and add a timer ([guide](https://docs/live-view#add-a-timer))."),
      text("Glad that helped!"),
    ]);
    const conv = await startConversation(app);

    expect((await send(app, conv, "How do I add a timer?")).status).toBe(201);
    await service.idle(conv.id);

    // The docs search result went back to the model.
    const toolResult = client.requests[1].messages.at(-1).content[0];
    expect(toolResult).toMatchObject({ type: "tool-result", toolCallId: "tu_search_docs", toolName: "search_docs" });
    expect(toolResult.output.value).toContain("https://docs/live-view#add-a-timer");
    // App context rides along with the first message only, as data.
    expect(client.requests[0].messages[0].content[0].text).toContain("<app_context>");

    await send(app, conv, "Thanks, that worked");
    await service.idle(conv.id);

    // Second turn replays the first turn unchanged, thinking blocks included.
    const second = client.requests[2].messages;
    expect(second.map((m: any) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    expect(second[1].content[0]).toEqual({ type: "reasoning", text: "", providerOptions: { anthropic: { signature: "sig" } } });
    // Only the newest block carries the cache breakpoint; the stored turns stay unmarked.
    expect(second[4].content).toEqual([{ type: "text", text: "Thanks, that worked", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }]);
    expect(JSON.stringify(second.slice(0, 4))).not.toContain("cacheControl");
    // So does the system prompt.
    expect(client.requests[2].raw.prompt[0].providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });

    const res = await app.request(`/api/conversations/${conv.id}/messages`, { headers: { Authorization: `Bearer ${conv.token}` } });
    const { messages, status } = (await res.json()) as any;
    expect(status).toBe("agent");
    expect(messages.map((m: any) => m.author)).toEqual(["user", "agent", "user", "agent"]);

    const [thread] = [...relay.threads.values()];
    expect(thread.posts).toEqual([
      "user: How do I add a timer?",
      "agent: Open Live View settings and add a timer ([guide](https://docs/live-view#add-a-timer)).",
      "user: Thanks, that worked",
      "agent: Glad that helped!",
    ]);
    expect(thread.conversation.reporterName).toBe("Sam");
  });

  it("hands off to a person, then relays team replies and keeps the agent quiet", async () => {
    const { app, client, relay, service } = setup([
      toolCall("handoff_to_human", { reason: "Wants a refund for last month" }),
      text("I've asked someone from the team to help with the refund. They'll reply here."),
    ]);
    const conv = await startConversation(app);
    await send(app, conv, "I need a refund");
    await service.idle(conv.id);

    expect(relay.humanRequests).toEqual(["thread_1: Wants a refund for last month"]);
    expect(service.get(conv.id)?.status).toBe("needs_human");

    await relay.staffReply("thread_1", "Hi Sam, I've refunded it.");
    await send(app, conv, "Thank you!");
    await service.idle(conv.id);

    expect(client.requests).toHaveLength(2); // the agent didn't run again
    expect(service.get(conv.id)?.status).toBe("human");
    expect(service.list(conv.id).map((m) => `${m.author}:${m.authorName ?? ""}`)).toEqual([
      "user:",
      "agent:",
      "system:", // waiting for the team
      "system:", // Matt joined
      "staff:Matt",
      "user:",
    ]);
    expect(service.list(conv.id).filter((m) => m.author === "system").map((m) => m.body)).toEqual([
      MESSAGES.waiting(),
      MESSAGES.joined("Matt"),
    ]);
    expect(relay.threads.get("thread_1")!.posts.at(-1)).toBe("user: Thank you!");
  });

  it("resolves when the team closes the post, and hands a new question back to the assistant", async () => {
    const { app, client, relay, service } = setup([
      toolCall("handoff_to_human", { reason: "Refund" }),
      text("I've asked the team."),
      text("Happy to help with that too."),
    ]);
    const conv = await startConversation(app);
    await send(app, conv, "I need a refund");
    await service.idle(conv.id);
    await relay.staffReply("thread_1", "Done!");

    expect(await relay.close("thread_1")).toBe(true);
    expect(await relay.close("thread_1")).toBe(false); // closing again is a no-op
    expect(service.get(conv.id)?.status).toBe("resolved");
    expect(service.list(conv.id).at(-1)).toMatchObject({ author: "system", body: expect.stringMatching(/resolved/) });

    await send(app, conv, "One more question");
    await service.idle(conv.id);
    expect(relay.events).toEqual(["resolved thread_1", "reopened thread_1"]);
    expect(client.requests).toHaveLength(3); // the assistant answered the new question
    expect(service.get(conv.id)?.status).toBe("agent");
  });

  it("resolves when the team deletes the post, and opens a new post if the user writes again", async () => {
    const { app, relay, service } = setup([text("Here's how."), text("Sure.")]);
    const conv = await startConversation(app);
    await send(app, conv, "How do timers work?");
    await service.idle(conv.id);
    expect(await relay.delete("thread_1")).toBe(true);
    expect(service.get(conv.id)).toMatchObject({ status: "resolved", relayThreadId: null });
    expect(relay.events).toEqual([]); // nothing to mark on a deleted post

    await send(app, conv, "Another question");
    await service.idle(conv.id);
    expect(service.get(conv.id)?.relayThreadId).toBe("thread_2");
    expect(relay.threads.get("thread_2")!.posts[0]).toBe("user: Another question");
  });

  it("hands a conversation back to the assistant when its post was deleted without notice", async () => {
    const { app, client, relay, service } = setup([toolCall("handoff_to_human", { reason: "Refund" }), text("Asked the team."), text("Here's how.")]);
    const conv = await startConversation(app);
    await send(app, conv, "I need a refund");
    await service.idle(conv.id);
    await relay.staffReply("thread_1", "On it");
    relay.vanish("thread_1");

    await send(app, conv, "How do timers work?");
    await service.idle(conv.id);
    expect(client.requests).toHaveLength(3); // the assistant answered again
    expect(service.get(conv.id)).toMatchObject({ status: "agent", relayThreadId: "thread_2" });
    expect(relay.threads.get("thread_2")!.posts).toEqual(["user: How do timers work?", "agent: Here's how."]);
  });

  it("hands off when the model declines or errors, without breaking the conversation", async () => {
    const { app, relay, service } = setup([{ content: [], stop_reason: "refusal" }]);
    const conv = await startConversation(app);
    await send(app, conv, "something odd");
    await service.idle(conv.id);
    expect(service.get(conv.id)?.status).toBe("needs_human");
    expect(relay.humanRequests).toHaveLength(1);
    expect(service.list(conv.id).at(-2)?.author).toBe("agent");
    expect(service.list(conv.id).at(-1)?.body).toBe(MESSAGES.waiting());

    const broken = setup([]); // client throws
    const conv2 = await startConversation(broken.app);
    await send(broken.app, conv2, "hello");
    await broken.service.idle(conv2.id);
    expect(broken.service.get(conv2.id)?.status).toBe("needs_human");
    expect(broken.service.list(conv2.id).at(-2)?.body).toMatch(/something went wrong/);
  });

  it("stops after maxSteps and hands off", async () => {
    const loops = Array.from({ length: 4 }, (_, i) => toolCall("search_docs", { query: "x" }, `tu_${i}`));
    const { app, client, service } = setup(loops);
    const conv = await startConversation(app);
    await send(app, conv, "loop forever");
    await service.idle(conv.id);
    expect(client.requests).toHaveLength(4);
    expect(service.get(conv.id)?.status).toBe("needs_human");
  });

  it("rejects requests without the conversation token", async () => {
    const { app } = setup([]);
    const conv = await startConversation(app);
    const res = await app.request(`/api/conversations/${conv.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
      body: JSON.stringify({ body: "hi" }),
    });
    expect(res.status).toBe(404);
    expect((await app.request(`/api/conversations/${conv.id}/events?token=nope`)).status).toBe(404);
  });

  it("lists summaries only for conversations whose token matches", async () => {
    const { app, service } = setup([text("Open Live View settings to add a timer.")]);
    const conv = await startConversation(app);
    await send(app, conv, "How do I add a timer?");
    await service.idle(conv.id);
    const other = await startConversation(app);
    const res = await app.request("/api/conversations/summaries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversations: [conv, { id: other.id, token: "wrong" }] }),
    });
    const { conversations } = (await res.json()) as { conversations: any[] };
    expect(conversations.map((c) => c.id)).toEqual([conv.id]);
    expect(conversations[0].title).toBe("How do I add a timer?");
    expect(conversations[0].last).toMatchObject({ author: "agent", body: "Open Live View settings to add a timer." });
  });

  it("limits new conversations per IP", async () => {
    const { app } = setup([]);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await app.request("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "1.2.3.4" },
        body: "{}",
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });
});

describe("sanitizeContext", () => {
  it("drops secret-looking keys and card numbers", () => {
    expect(
      sanitizeContext({ page: "/x", authToken: "abc", note: "card 4242 4242 4242 4242", nested: { password: "p", ok: 1 } }),
    ).toEqual({ page: "/x", note: "card [redacted-number]", nested: { ok: 1 } });
  });
});

describe("RateLimiter", () => {
  it("resets after an hour", () => {
    const rl = new RateLimiter();
    expect([rl.allow("k", 1, 0), rl.allow("k", 1, 10)]).toEqual([true, false]);
    expect(rl.allow("k", 1, 3_600_000)).toBe(true);
  });
});

describe("answerOnce (community forum posts)", () => {
  it("answers from the docs and flags posts the assistant hands off", async () => {
    const { answerOnce } = await import("../src/agent/agent.js");
    const docs = { searchDocs: () => [{ title: "Live View", heading: "Timers", url: "https://docs/x", snippet: "Add a timer" }], readDoc: () => null };

    const ok = new Agent(new FakeClient([toolCall("search_docs", { query: "timer" }), text("Add a timer in Live View: https://docs/x")]), agentOpts);
    expect(await answerOnce(ok, "How do timers work?", docs)).toEqual({ reply: "Add a timer in Live View: https://docs/x", needsHuman: false });

    const human = new Agent(new FakeClient([toolCall("handoff_to_human", { reason: "billing" }), text("The team will help with billing.")]), agentOpts);
    expect((await answerOnce(human, "I was double charged", docs)).needsHuman).toBe(true);
  });
});
