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
      const extra = { ...(t.planned ? { planned: true } : {}), ...(t.reason ? { reason: t.reason } : {}) };
      return [{ ...plain(t), ...extra, ...(dup ? { duplicateOf: plain(dup) } : {}) }];
    });
  }
  set(key: string, state: TrackedTicket["state"], dupOfKey?: string, extra: { planned?: boolean; reason?: string } = {}) {
    const t = [...this.tickets.values()].find((x) => x.key === key)!;
    t.state = state;
    Object.assign(t, extra);
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
  const desk = new TicketDesk(db, tracker, { notify: (n) => service.ticketNews(n), log: () => {} });
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
      toolCall("add_to_ticket", { key: "ED-1", kind: "bug", note: "Also happens on v1.5.", user_summary: "the timer running fast after pausing" }, "b2"),
      text("Thanks, that's a known issue. I've added your report and I'll let you know here when it's fixed."),
    ]);

    const sam = await chat(s, "Sam", "The timer drifts after I pause it");
    const ticket = s.tracker.tickets.get("id1")!;
    expect(ticket.title).toBe("Timer drifts after pausing");
    expect(ticket.description).toContain(`Reported by Sam in chat (https://wicket.test/admin/c/${sam.id})`);
    // The model was told the person will hear back.
    expect(s.client.requests[2].messages.at(-1).content[0].content).toContain("Filed ED-1. They'll also see a card saying it's logged");
    // After the reply, Sam sees a card: logged, with the team, and they'll hear back.
    const samLogged = s.service.list(sam.id).at(-1)!;
    expect(samLogged).toMatchObject({ author: "system", event: "logged", body: "Logged for the team: the timer drifting after a pause. You'll hear back here when it's fixed." });
    expect(samLogged.card).toMatchObject({ type: "ticket", stage: "logged", kind: "bug", summary: "the timer drifting after a pause" });
    expect(s.service.list(sam.id).at(-2)!.author).toBe("agent");
    // The ticket tools and instructions were offered.
    expect(s.client.requests[0].tools.map((t: any) => t.name)).toEqual(expect.arrayContaining(["find_tickets", "file_ticket", "add_to_ticket"]));
    expect(s.client.requests[0].system[0].text).toContain("use find_tickets");

    const alex = await chat(s, "Alex", "My timer runs fast after a pause");
    expect(s.client.requests[4].messages.at(-1).content[0].content).toBe("ED-1: Timer drifts after pausing (1 report from chat)");
    expect(ticket.comments).toHaveLength(1);
    expect(ticket.comments[0]).toContain("Another report from Alex in chat");
    expect(ticket.comments[0]).toContain("Also happens on v1.5.");
    expect(s.tracker.tickets.size).toBe(1);
    // Alex's card says they're not the only one.
    expect(s.service.list(alex.id).at(-1)!.card).toMatchObject({ stage: "logged", others: 1, summary: "the timer running fast after pausing" });

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
    expect(samNews).toMatchObject({ author: "agent", event: "fixed", card: { type: "ticket", stage: "done", kind: "bug", summary: "the timer drifting after a pause" } });
    expect(samNews.card!.doneAt).toBeTypeOf("number");
    expect(samNews.body).toBe("Good news: the timer drifting after a pause is fixed. Thanks for reporting it, and let me know if you still see it.");
    expect(s.service.list(alex.id).at(-1)!.body).toContain("the timer running fast after pausing is fixed");
    expect(samThread.posts.at(-1)).toBe("system: ✅ ED-1 is done, so I let them know.");
    expect(s.service.summary(sam.id)!.news).toBe(true);
    // Their conversation list shows where the report stands.
    expect(s.service.summary(sam.id)!.report).toMatchObject({ stage: "done", kind: "bug", summary: "the timer drifting after a pause" });

    // Each person hears once.
    expect(await s.desk.check()).toBe(0);
    expect(s.service.list(sam.id).filter((m) => m.event === "fixed")).toHaveLength(1);

    // And by email, when they haven't seen it in the app.
    await s.emails.sweep(Date.now() + 10 * 60_000);
    expect(s.mail.map((m) => m.subject)).toEqual(["An update on something you reported · Escape Director", "An update on something you reported · Escape Director"]);
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

  it("tells ideas when the team plans them, and doesn't tell anyone twice", async () => {
    const s = setup([]);
    const conv = s.service.create({ name: "Sam" }, undefined);
    const idea = await s.desk.file({ title: "Public leaderboard", kind: "feature", description: "" }, { conversationId: conv.id, summary: "a public leaderboard" });
    const bug = await s.desk.file({ title: "Timer drift", kind: "bug", description: "" }, { conversationId: "c2" });
    const told: string[] = [];
    const deliver = (s.desk as any).opts.notify;
    (s.desk as any).opts.notify = async (n: any) => {
      told.push(`${n.stage}:${n.conversationId}`);
      await deliver(n);
    };

    // Still in triage: nothing to say.
    expect(await s.desk.check()).toBe(0);
    s.tracker.set(idea.key, "open", undefined, { planned: true });
    s.tracker.set(bug.key, "open", undefined, { planned: true }); // bugs just hear when it's fixed
    expect(await s.desk.check()).toBe(1);
    expect(await s.desk.check()).toBe(0);
    const news = s.service.list(conv.id).at(-1)!;
    expect(news).toMatchObject({ author: "agent", event: "planned", card: { stage: "planned", summary: "a public leaderboard" } });
    expect(news.body).toBe("Good news: the team is planning to build a public leaderboard. You'll hear back here when it ships.");
    expect(s.service.summary(conv.id)!.news).toBe(true);

    // Someone asking for it now hears it's already planned, rather than a second notice later.
    const added = await s.desk.add(idea.key, { conversationId: "c3", comment: "+1", kind: "feature" });
    expect(added).toMatchObject({ planned: true, reports: 2 });
    expect(await s.desk.check()).toBe(0);

    s.tracker.set(idea.key, "done");
    expect(await s.desk.check()).toBe(2);
    expect(told[0]).toBe(`planned:${conv.id}`);
    expect(told.slice(1).sort()).toEqual([`done:${conv.id}`, "done:c3"].sort());
  });

  it("tells reporters when the team declines, after giving them time to write why", async () => {
    const s = setup([]);
    const conv = s.service.create({ name: "Sam" }, undefined);
    const idea = await s.desk.file({ title: "Confetti", kind: "feature", description: "" }, { conversationId: conv.id, summary: "confetti on escape" });
    const quiet = await s.desk.file({ title: "Can't reproduce", kind: "bug", description: "" }, { conversationId: "c2" });
    const wontFix = await s.desk.file({ title: "Old browser", kind: "bug", description: "" }, { conversationId: "c3" });
    const told: string[] = [];
    const deliver = (s.desk as any).opts.notify;
    (s.desk as any).opts.notify = async (n: any) => {
      told.push(`${n.stage}:${n.conversationId}:${n.reason ?? ""}`);
      if (n.conversationId === conv.id) await deliver(n);
    };

    s.tracker.set(idea.key, "closed");
    s.tracker.set(quiet.key, "closed");
    s.tracker.set(wontFix.key, "closed", undefined, { reason: "We only support the last two versions of each browser." });
    const now = Date.now();
    expect(await s.desk.check(new Date(now))).toBe(0);
    // The team adds their reason after canceling, within the grace period.
    s.tracker.set(idea.key, "closed", undefined, { reason: "It would distract players mid-game." });
    expect(await s.desk.check(new Date(now + 30 * 60_000))).toBe(0);
    expect(await s.desk.check(new Date(now + 61 * 60_000))).toBe(2);
    expect(told.sort()).toEqual([`declined:${conv.id}:It would distract players mid-game.`, "declined:c3:We only support the last two versions of each browser."].sort());
    expect(s.service.list(conv.id).at(-1)).toMatchObject({
      event: "declined",
      card: { stage: "declined", reason: "It would distract players mid-game." },
      body: `The team looked at confetti on escape and decided not to build it for now. Here's what they said: "It would distract players mid-game." Thanks for suggesting it.`,
    });
    // Nobody hears twice, and the bug closed without a word stays quiet.
    expect(await s.desk.check(new Date(now + 120 * 60_000))).toBe(0);
    expect(told).toHaveLength(2);
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
      const data = body.query.includes("teams(")
        ? { teams: { nodes: [{ id: "team", states: { nodes: [{ id: "s1", name: "Triage", type: "triage", position: 0 }] } }] } }
        : body.query.includes("labels(")
          ? { team: { labels: { nodes: [] } }, issueLabels: { nodes: [] } }
          : body.query.includes("issues(")
            ? { issues: { nodes: [node("ed-1", "completed"), node("ed-2", "canceled"), node("ed-3", "backlog"), node("ed-4", "triage")] } }
            : {
                issue: {
                  relations: { nodes: [{ type: "related", relatedIssue: node("ed-9", "started") }, { type: "duplicate", relatedIssue: node("ed-1", "completed") }] },
                  comments: { nodes: [{ body: "Internal: dupe", createdAt: "2026-10-14T01:00:00Z" }, { body: "Reply: Merged into the main request.", createdAt: "2026-10-14T02:00:00Z" }] },
                },
              };
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const t = new LinearTracker({ apiKey: "k", teamKey: "ED" });
    const states = await t.states(["ed-1", "ed-2", "ed-3", "ed-4"]);
    expect(states.map((s) => `${s.key}:${s.state}:${s.duplicateOf?.key ?? ""}:${s.planned ? "planned" : ""}`)).toEqual([
      "ED-1:done::",
      "ED-2:closed:ED-1:",
      "ED-3:open::planned", // out of triage
      "ED-4:open::",
    ]);
    expect(states[1]!.reason).toBe("Merged into the main request.");
    expect(queries.filter((q) => q.includes("relations"))).toHaveLength(1); // only for the canceled one
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
