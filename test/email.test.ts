import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { ConversationService } from "../src/conversations.js";
import { ReplyEmails, replyText, sign, verifyWebhook, type InboundMail, type Mail, type Mailer } from "../src/email.js";
import { createServer } from "../src/server.js";
import { FakeRelay } from "./helpers.js";

const ORIGIN = "http://localhost";
const MIN = 60_000;

class FakeMailer implements Mailer {
  sent: Mail[] = [];
  inbox = new Map<string, InboundMail>();
  async send(mail: Mail) {
    this.sent.push(mail);
  }
  async received(id: string) {
    return this.inbox.get(id) ?? null;
  }
}

function setup({ replyDomain = "in.example.com" as string | undefined, teamEmails = [] as string[] } = {}) {
  const db = openDb(":memory:");
  const relay = new FakeRelay();
  const mailer = new FakeMailer();
  const service = new ConversationService(db, null, relay, { log: () => {}, emailReplies: true });
  void relay.start(({ threadId, authorName, body, files, ...from }) => service.handleStaffReply(threadId, authorName, body, files, from));
  const replies = new ReplyEmails(db, service, mailer, { productName: "Escape Director", publicUrl: "https://wicket.test", replyDomain });
  const app = createServer(service, {
    allowedOrigins: [],
    maxConversationsPerIpPerHour: 50,
    maxMessagesPerConversationPerHour: 50,
    productName: "Escape Director",
    email: { replies, webhookSecret: "whsec_" + Buffer.from("secret-key").toString("base64") },
    team: { db, productName: "Escape Director", email: teamEmails.length ? { mailer, allowed: teamEmails } : undefined },
  });
  return { db, relay, mailer, service, replies, app };
}

async function conversation(app: ReturnType<typeof setup>["app"], service: ConversationService, email: string | null = "sam@example.com") {
  const res = await app.request("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reporter: { name: "Sam", ...(email ? { email } : {}) } }),
  });
  const conv = (await res.json()) as { id: string; token: string };
  await app.request(`/api/conversations/${conv.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${conv.token}` },
    body: JSON.stringify({ body: "The timer froze" }),
  });
  await service.idle(conv.id);
  return conv;
}

const read = (app: ReturnType<typeof setup>["app"], conv: { id: string; token: string }) =>
  app.request(`/api/conversations/${conv.id}/messages`, { headers: { Authorization: `Bearer ${conv.token}` } });

describe("emailing team replies", () => {
  it("emails a reply the user hasn't seen, once, after a few minutes", async () => {
    const { app, relay, mailer, service, replies } = setup();
    const conv = await conversation(app, service);
    expect(service.list(conv.id).at(-1)!.body).toBe("Passed to the team. Someone will reply here. We'll email you when they do.");

    await relay.staffReply([...relay.threads.keys()][0]!, "Which browser are you on?");
    expect(await replies.sweep()).toBe(0); // too soon
    expect(await replies.sweep(Date.now() + 6 * MIN)).toBe(1);
    expect(await replies.sweep(Date.now() + 7 * MIN)).toBe(0); // already sent

    const mail = mailer.sent[0]!;
    expect(mail.to).toBe("sam@example.com");
    expect(mail.subject).toBe("Matt replied · Escape Director");
    expect(mail.text).toContain("Which browser are you on?");
    expect(mail.text).toContain(`https://wicket.test/chat/${conv.id}#${conv.token}`);
    expect(mail.replyTo).toBe(`reply+${conv.id}.${sign(conv.token, "reply")}@in.example.com`);
    expect(mail.headers!["List-Unsubscribe"]).toContain(`/email/unsubscribe/${conv.id}/`);
  });

  it("doesn't email what the widget already showed", async () => {
    const { app, relay, mailer, service, replies } = setup();
    const conv = await conversation(app, service);
    await relay.staffReply([...relay.threads.keys()][0]!, "Try a hard refresh.");
    await read(app, conv);
    expect(await replies.sweep(Date.now() + 10 * MIN)).toBe(0);
    expect(mailer.sent).toEqual([]);
  });

  it("sends at most one email an hour, with every unread reply in it", async () => {
    const { app, relay, mailer, service, replies } = setup();
    const conv = await conversation(app, service);
    const thread = [...relay.threads.keys()][0]!;
    await relay.staffReply(thread, "First");
    await replies.sweep(Date.now() + 6 * MIN);
    await relay.staffReply(thread, "Second");
    await relay.staffReply(thread, "Third");
    expect(await replies.sweep(Date.now() + 20 * MIN)).toBe(0);
    expect(await replies.sweep(Date.now() + 70 * MIN)).toBe(1);
    expect(mailer.sent[1]!.text).toContain("Second");
    expect(mailer.sent[1]!.text).toContain("Third");
    expect(mailer.sent[1]!.text).not.toContain("First");
    void conv;
  });

  it("stops after unsubscribing, and only with the right link", async () => {
    const { app, relay, mailer, service, replies } = setup();
    const conv = await conversation(app, service);
    expect((await app.request(`/email/unsubscribe/${conv.id}/wrong`, { method: "POST" })).status).toBe(404);
    // Opening the link only asks.
    expect((await app.request(`/email/unsubscribe/${conv.id}/${sign(conv.token, "unsub")}`)).status).toBe(200);
    expect(service.get(conv.id)!.emailOptOut).toBeFalsy();
    expect((await app.request(`/email/unsubscribe/${conv.id}/${sign(conv.token, "unsub")}`, { method: "POST" })).status).toBe(200);
    await relay.staffReply([...relay.threads.keys()][0]!, "Hello?");
    expect(await replies.sweep(Date.now() + 10 * MIN)).toBe(0);
    expect(mailer.sent).toEqual([]);
  });

  it("doesn't promise an email without an address", async () => {
    const { app, service } = setup();
    const conv = await conversation(app, service, null);
    expect(service.list(conv.id).at(-1)!.body).toBe("Passed to the team. Someone will reply here.");
  });
});

describe("replies by email", () => {
  async function webhook(app: ReturnType<typeof setup>["app"], payload: object, secret = Buffer.from("secret-key")) {
    const body = JSON.stringify(payload);
    const id = "msg_1";
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac("sha256", secret).update(`${id}.${ts}.${body}`).digest("base64");
    return app.request("/email/inbound", { method: "POST", headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` }, body });
  }

  it("posts the new part of a reply into the conversation and the Discord post", async () => {
    const { app, relay, mailer, service } = setup();
    const conv = await conversation(app, service);
    const to = `reply+${conv.id}.${sign(conv.token, "reply")}@in.example.com`;
    mailer.inbox.set("em_1", {
      from: "Sam <SAM@example.com>",
      to: [to],
      text: "Chrome, latest version.\n\nOn Mon, Oct 13, 2026 at 9:00 AM Escape Director <support@ed.com> wrote:\n> Which browser are you on?",
      html: null,
    });
    expect((await webhook(app, { type: "email.received", data: { email_id: "em_1" } })).status).toBe(200);
    await service.idle(conv.id);
    expect(service.list(conv.id).at(-1)).toMatchObject({ author: "user", body: "Chrome, latest version." });
    expect([...relay.threads.values()][0]!.posts.at(-1)).toBe("user: Chrome, latest version.");
  });

  it("ignores replies from another address, to a forged address, or with a bad signature", async () => {
    const { app, mailer, service } = setup();
    const conv = await conversation(app, service);
    const before = service.list(conv.id).length;
    mailer.inbox.set("em_other", { from: "eve@example.com", to: [`reply+${conv.id}.${sign(conv.token, "reply")}@in.example.com`], text: "hi", html: null });
    mailer.inbox.set("em_forged", { from: "sam@example.com", to: [`reply+${conv.id}.AAAAAAAAAAAAAAAA@in.example.com`], text: "hi", html: null });
    await webhook(app, { type: "email.received", data: { email_id: "em_other" } });
    await webhook(app, { type: "email.received", data: { email_id: "em_forged" } });
    expect((await webhook(app, { type: "email.received", data: { email_id: "em_other" } }, Buffer.from("wrong"))).status).toBe(401);
    expect(service.list(conv.id).length).toBe(before);
  });

  it("finds the reply above quoted text in common mail apps", () => {
    expect(replyText("Thanks!\r\n\r\nOn Mon, Oct 13, 2026 at 9:00 AM\r\nTeam <a@b.c> wrote:\r\n> old")).toBe("Thanks!");
    expect(replyText("Sounds good\n\n-----Original Message-----\nFrom: x")).toBe("Sounds good");
    expect(replyText("## Reply above this line to answer. ##")).toBe("");
    expect(verifyWebhook("whsec_" + Buffer.from("k").toString("base64"), { id: "1", timestamp: "0", signature: "v1,x" }, "{}")).toBe(false);
  });
});

describe("chat page and email sign-in", () => {
  it("serves a page with just the chat for email links", async () => {
    const { app } = setup();
    const res = await app.request("/chat/abc");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Escape Director support");
    expect(html).toContain("page: true");
  });

  it("signs a teammate in with a one-time link, linked to their Discord account", async () => {
    const { app, mailer, service } = setup({ teamEmails: ["alex@ed.com:d-alex"] });
    service.members.upsertDiscord("d-alex", "Alex Rivera");
    const ask = (email: string) =>
      app.request("/admin/auth/email", { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ email }) });

    expect((await ask("stranger@ed.com")).status).toBe(200); // same answer, no email
    expect(mailer.sent).toEqual([]);
    expect((await ask("Alex@ED.com")).status).toBe(200);
    const link = /https?:\/\/[^\s]+\/admin\/auth\/email\/([\w-]+)/.exec(mailer.sent[0]!.text)!;
    const path = new URL(link[0]).pathname;

    // Opening the link doesn't use it up; the button does.
    expect((await app.request(path)).status).toBe(200);
    const res = await app.request(path, { method: "POST", headers: { Origin: ORIGIN } });
    expect(res.headers.get("location")).toBe("/admin");
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const me = (await (await app.request("/admin/api/me", { headers: { Cookie: cookie } })).json()) as { member: { name: string; discordId: string } };
    expect(me.member).toMatchObject({ name: "Alex Rivera", discordId: "d-alex" });

    const again = await app.request(path, { method: "POST", headers: { Origin: ORIGIN } });
    expect(again.headers.get("location")).toBe("/admin?error=link");
  });

  it("offers email sign-in only when it's set up", async () => {
    const withEmail = setup({ teamEmails: ["alex@ed.com"] });
    const res = await withEmail.app.request("/admin/api/me");
    expect(((await res.json()) as any).signIn).toMatchObject({ email: true, discord: false });
    expect((await setup().app.request("/admin/auth/email", { method: "POST", headers: { Origin: ORIGIN }, body: "{}" })).status).toBe(404);
  });
});
