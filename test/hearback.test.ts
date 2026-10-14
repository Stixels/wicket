import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/index.js";
import { Agent } from "../src/agent/agent.js";
import { ConversationService } from "../src/conversations.js";
import { TicketDesk } from "../src/tickets.js";
import { ReplyEmails, type Mail } from "../src/email.js";
import { parseSettings } from "../src/settings.js";
import { createServer } from "../src/server.js";
import { ticketRefs } from "../src/discord/tickets.js";
import { LinearTracker } from "../src/adapters/tracker/linear.js";
import type { TicketDraft, TrackedTicket, Tracker } from "../src/adapters/types.js";
import { FakeClient, FakeRelay, text, toolCall } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

/** An in-memory tracker the tests can mark done, close or merge. */
class FakeTracker implements Tracker {
  name = "fake";
  tickets = new Map<string, TrackedTicket & { description: string; comments: string[] }>();
  private n = 0;
  async create(t: TicketDraft) {
    const id = `id${++this.n}`;
    const key = `ED-${this.n}`;
    this.tickets.set(id, { id, key, url: `https://tracker/${key}`, title: t.title, state: "open", description: t.description, comments: [] });
    return { id, key, url: `https://tracker/${key}` };
  }
  async search(text: string) {
    const words = text.toLowerCase().split(/\W+/);
    return [...this.tickets.values()].filter((t) => t.state === "open" && words.some((w) => w && t.title.toLowerCase().includes(w))).map(plain);
  }
  async get(keyOrUrl: string) {
    const t = [...this.tickets.values()].find((x) => x.key === keyOrUrl || x.url === keyOrUrl);
    return t ? plain(t) : null;
  }
  async comment(id: string, body: string) {
    this.tickets.get(id)!.comments.push(body);
  }
  async states(ids: string[]) {
    return ids.flatMap((id) => {
      const t = this.tickets.get(id);
      if (!t) return [];
      const dup = (t as any).dupOf ? this.tickets.get((t as any).dupOf) : undefined;
      return [{ ...plain(t), ...(dup ? { duplicateOf: plain(dup) } : {}) }];
    });
  }
  set(key: string, state: TrackedTicket["state"], dupOfKey?: string) {
    const t = [...this.tickets.values()].find((x) => x.key === key)!;
    t.state = state;
    if (dupOfKey) (t as any).dupOf = [...this.tickets.values()].find((x) => x.key === dupOfKey)!.id;
  }
}

const plain = (t: TrackedTicket): TrackedTicket => ({ id: t.id, key: t.key, url: t.url, title: t.title, state: t.state });

const agentOpts = { model: "claude-opus-5-5", effort: "low" as const, maxSteps: 6, productName: "Escape Director", productDescription: "" };

function setup(responses: ConstructorParameters<typeof FakeClient>[0], yaml = "") {
  const db = openDb(":memory:");
  const client = new FakeClient(responses);
  const relay = new FakeRelay();
  const tracker = new FakeTracker();
  const mail: Mail[] = [];
  // eslint-disable-next-line prefer-const
  let service: ConversationService;
  const desk = new TicketDesk(db, tracker, { notify: (n) => service.shipped(n), log: () => {} });
  service = new ConversationService(db, new Agent(client, agentOpts), relay, {
    log: () => {},
    tickets: desk,
    publicUrl: "https://wicket.test",
    settings: parseSettings(yaml),
    emailReplies: true,
  });
  void relay.start(({ threadId, authorName, body }) => service.handleStaffReply(threadId, authorName, body));
  const app = createServer(service, { allowedOrigins: [], maxConversationsPerIpPerHour: 50, maxMessagesPerConversationPerHour: 50 });
  const emails = new ReplyEmails(db, service, { send: async (m) => void mail.push(m) }, { productName: "Escape Director", publicUrl: "https://wicket.test" });
  return { db, client, relay, tracker, desk, service, app, emails, mail };
}

async function chat(s: ReturnType<typeof setup>, name: string, body: string) {
  const res = await s.app.request("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reporter: { name, email: `${name.toLowerCase()}@example.com` } }),
  });
  const conv = (await res.json()) as { id: string; token: string };
  await s.app.request(`/api/conversations/${conv.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${conv.token}` },
    body: JSON.stringify({ body }),
  });
  await s.service.idle(conv.id);
  return conv;
}

describe("everyone hears back", () => {
  it("files the first report, folds the second into it, and tells both when it's done", async () => {
    const s = setup([
      // Sam reports it: nothing matches, so the assistant files it.
      toolCall("find_tickets", { query: "timer drift pause" }, "a1"),
      toolCall("file_ticket", { title: "Timer drifts after pausing", kind: "bug", description: "The room timer drifts.", user_summary: "the timer drifting after a pause" }, "a2"),
      text("Thanks! I've logged it, and I'll message you here when it's fixed."),
      // Alex reports the same thing: the assistant finds Sam's ticket and adds to it.
      toolCall("find_tickets", { query: "timer drift" }, "b1"),
      toolCall("add_to_ticket", { key: "ED-1", note: "Also happens on v1.5.", user_summary: "the timer running fast after pausing" }, "b2"),
      text("Thanks, that's a known issue. I've added your report and I'll let you know here when it's fixed."),
    ]);

    const sam = await chat(s, "Sam", "The timer drifts after I pause it");
    const ticket = s.tracker.tickets.get("id1")!;
    expect(ticket.title).toBe("Timer drifts after pausing");
    expect(ticket.description).toContain(`Reported by Sam in chat (https://wicket.test/admin/c/${sam.id})`);
    // The model was told the person will hear back.
    expect(s.client.requests[2].messages.at(-1).content[0].content).toContain("Filed ED-1. They'll get a message here when it's done");
    // The ticket tools and instructions were offered.
    expect(s.client.requests[0].tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["find_tickets", "file_ticket", "add_to_ticket"]));
    expect(s.client.requests[0].system[0].text).toContain("use find_tickets");

    const alex = await chat(s, "Alex", "My timer runs fast after a pause");
    expect(s.client.requests[4].messages.at(-1).content[0].content).toBe("ED-1: Timer drifts after pausing (1 report from chat)");
    expect(ticket.comments).toHaveLength(1);
    expect(ticket.comments[0]).toContain("Another report from Alex in chat");
    expect(ticket.comments[0]).toContain("Also happens on v1.5.");
    expect(s.tracker.tickets.size).toBe(1);

    // The team sees which ticket each conversation is on.
    expect(s.desk.forConversation(alex.id)).toEqual([
      { key: "ED-1", url: "https://tracker/ED-1", title: "Timer drifts after pausing", state: "open", relation: "added", notified: false },
    ]);
    const samThread = [...s.relay.threads.values()].find((t) => t.conversation.id === sam.id)!;
    expect(samThread.posts).toContain("system: 🎫 Filed [ED-1](https://tracker/ED-1): Timer drifts after pausing");

    // Nothing happens while it's open.
    expect(await s.desk.check()).toBe(0);

    s.tracker.set("ED-1", "done");
    expect(await s.desk.check()).toBe(2);
    const samNews = s.service.list(sam.id).at(-1)!;
    expect(samNews).toMatchObject({ author: "agent", event: "fixed" });
    expect(samNews.body).toBe("Good news: the timer drifting after a pause is fixed. Thanks for reporting it, and let me know if you still see it.");
    expect(s.service.list(alex.id).at(-1)!.body).toContain("the timer running fast after pausing is fixed");
    expect(samThread.posts.at(-1)).toBe("system: ✅ ED-1 is done, so I let them know.");
    expect(s.service.summary(sam.id)!.news).toBe(true);

    // Each person hears once.
    expect(await s.desk.check()).toBe(0);
    expect(s.service.list(sam.id).filter((m) => m.event)).toHaveLength(1);

    // And by email, when they haven't seen it in the app.
    await s.emails.sweep(Date.now() + 10 * 60_000);
    expect(s.mail.map((m) => m.subject)).toEqual(["Something you reported is done · Escape Director", "Something you reported is done · Escape Director"]);
    expect(s.mail[0]!.text).toContain("Escape Director:\nGood news");

    // Reading the conversation clears the news.
    await s.app.request(`/api/conversations/${sam.id}/messages`, { headers: { Authorization: `Bearer ${sam.token}` } });
    expect(s.service.summary(sam.id)!.news).toBe(false);
  });

  it("passes reporters on when the team closes a ticket as a duplicate, and stays quiet when it's just closed", async () => {
    const s = setup([]);
    const a = await s.desk.file({ title: "Hint button missing", kind: "bug", description: "" }, { conversationId: "c1", summary: "the missing hint button" });
    const b = await s.desk.file({ title: "No hint button on tablet", kind: "bug", description: "" }, { conversationId: "c2" });
    const c = await s.desk.file({ title: "Confetti", kind: "feature", description: "" }, { conversationId: "c3" });
    const told: string[] = [];
    (s.desk as any).opts.notify = async (n: any) => void told.push(`${n.conversationId}:${n.key}:${n.summary ?? n.title}`);

    s.tracker.set(b.key, "closed", a.key); // b is a duplicate of a
    s.tracker.set(c.key, "closed"); // won't do
    expect(await s.desk.check()).toBe(0);
    expect(s.desk.forConversation("c2").map((t) => t.key)).toEqual([a.key]);
    expect(s.desk.forConversation("c3")[0]!.state).toBe("closed");

    s.tracker.set(a.key, "done");
    expect(await s.desk.check()).toBe(2);
    expect(told.sort()).toEqual([`c1:${a.key}:the missing hint button`, `c2:${a.key}:Hint button missing`]);
  });

  it("retries a notice that couldn't be delivered", async () => {
    const s = setup([]);
    const t = await s.desk.file({ title: "Export fails", kind: "bug", description: "" }, { conversationId: "c1" });
    let fail = true;
    (s.desk as any).opts.notify = async () => {
      if (fail) throw new Error("down");
    };
    s.tracker.set(t.key, "done");
    expect(await s.desk.check()).toBe(0);
    fail = false;
    // The ticket is done now, but the reporter still hasn't heard, so the next check tries again.
    expect(await s.desk.check()).toBe(1);
    expect(await s.desk.check()).toBe(0);
  });

  it("doesn't offer ticket tools when the assistant shouldn't log tickets", async () => {
    const s = setup([text("Thanks, I'll pass that on.")], "tickets:\n  assistant: false\n");
    await chat(s, "Sam", "Please add dark mode");
    expect(s.client.requests[0].tools.map((t: any) => t.name)).not.toContain("file_ticket");
    expect(s.client.requests[0].system[0].text).not.toContain("find_tickets");
  });

  it("reads ticket keys and links from a teammate's message", () => {
    expect(ticketRefs("+1 ED-123 please, see <#123456789> and https://linear.app/x/issue/ED-9/slug.")).toEqual(["ED-123", "https://linear.app/x/issue/ED-9/slug"]);
    expect(ticketRefs("same as #45")).toEqual(["#45"]);
    expect(ticketRefs("file this as a bug")).toEqual([]);
  });
});

describe("LinearTracker follow-up", () => {
  it("maps states and finds what a canceled issue duplicates", async () => {
    const queries: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      queries.push(body.query);
      const node = (id: string, type: string) => ({ id, identifier: id.toUpperCase(), url: `https://linear.app/x/issue/${id}`, title: id, state: { type } });
      const data = body.query.includes("issues(")
        ? { issues: { nodes: [node("ed-1", "completed"), node("ed-2", "canceled"), node("ed-3", "started")] } }
        : { issue: { relations: { nodes: [{ type: "related", relatedIssue: node("ed-9", "started") }, { type: "duplicate", relatedIssue: node("ed-1", "completed") }] } } };
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const t = new LinearTracker({ apiKey: "k", teamKey: "ED" });
    const states = await t.states(["ed-1", "ed-2", "ed-3"]);
    expect(states.map((s) => `${s.key}:${s.state}:${s.duplicateOf?.key ?? ""}`)).toEqual(["ED-1:done:", "ED-2:closed:ED-1", "ED-3:open:"]);
    expect(queries).toHaveLength(2); // relations only for the canceled one
  });

  it("looks up an issue by key or link", async () => {
    const ids: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: any) => {
      const { variables } = JSON.parse(init.body);
      ids.push(variables.id);
      return new Response(JSON.stringify({ data: { issue: { id: "u1", identifier: variables.id, url: "u", title: "t", state: { type: "triage" } } } }), { status: 200 });
    });
    const t = new LinearTracker({ apiKey: "k", teamKey: "ED" });
    expect((await t.get("https://linear.app/acme/issue/ED-7/timer"))?.state).toBe("open");
    expect(await t.get("ed-8")).not.toBeNull();
    expect(await t.get("#45")).toBeNull();
    expect(ids).toEqual(["ED-7", "ED-8"]);
  });
});
