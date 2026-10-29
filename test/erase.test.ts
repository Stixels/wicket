import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb, schema } from "../src/db/index.js";
import { ConversationService } from "../src/conversations.js";
import { createServer } from "../src/server.js";
import { signUserToken, verifyEraseToken, verifyUserToken } from "../src/identity.js";
import { FakeRelay } from "./helpers.js";

const SECRET = "test-secret-test-secret-test-secret!";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

function setup() {
  const db = openDb(":memory:");
  const relay = new FakeRelay();
  const service = new ConversationService(db, null, relay, () => {});
  void relay.start(({ threadId, authorName, body, files }) => service.handleStaffReply(threadId, authorName, body, files));
  const app = createServer(service, { allowedOrigins: [], maxConversationsPerIpPerHour: 50, maxMessagesPerConversationPerHour: 50, identitySecret: SECRET });
  return { db, relay, service, app };
}

type App = ReturnType<typeof setup>["app"];

const json = (app: App, url: string, body: object, auth?: string) =>
  app.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  });

/** Starts a conversation as this person, with a message and a screenshot, so it has a team thread and a file. */
async function chat(app: App, service: ConversationService, claims: { sub: string; account?: string }) {
  const userToken = signUserToken(claims, SECRET);
  const conv = (await (await json(app, "/api/conversations", { userToken })).json()) as { id: string; token: string };
  const form = new FormData();
  form.append("file", new File([new Uint8Array(PNG)], "error.png", { type: "image/png" }));
  const up = await app.request(`/api/conversations/${conv.id}/files`, { method: "POST", headers: { Authorization: `Bearer ${conv.token}` }, body: form });
  const { file } = (await up.json()) as { file: { id: string } };
  await json(app, `/api/conversations/${conv.id}/messages`, { body: "The timer is stuck", attachments: [file.id], userToken }, conv.token);
  await service.idle(conv.id);
  return { ...conv, fileId: file.id, threadId: service.get(conv.id)!.relayThreadId! };
}

const erase = (app: App, claims: { sub: string; account?: string; scope?: "erase" }) => app.request("/api/erase", { method: "POST", headers: { Authorization: `Bearer ${signUserToken(claims, SECRET)}` } });

describe("deleting an account's conversations", () => {
  it("removes the owner's and their team's chats, files and team threads, and nobody else's", async () => {
    const { app, service, relay, db } = setup();
    const owner = await chat(app, service, { sub: "owner", account: "owner" });
    const manager = await chat(app, service, { sub: "manager", account: "owner" });
    const other = await chat(app, service, { sub: "someone-else", account: "someone-else" });
    expect(owner.threadId).toBeTruthy();

    const res = await erase(app, { sub: "owner", account: "owner", scope: "erase" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 2, failed: 0 });

    for (const gone of [owner, manager]) {
      expect(service.get(gone.id)).toBeUndefined();
      expect(service.list(gone.id)).toEqual([]);
      expect(relay.threads.has(gone.threadId)).toBe(false);
      expect(fs.existsSync(path.join(service.files.dir, gone.fileId))).toBe(false);
      expect((await app.request(`/files/${gone.fileId}/error.png`)).status).toBe(404);
    }
    expect(db.select().from(schema.files).all().map((f) => f.id)).toEqual([other.fileId]);
    expect(service.get(other.id)).toBeDefined();
    expect(relay.threads.has(other.threadId)).toBe(true);

    // Running it again is harmless.
    expect(await (await erase(app, { sub: "owner", account: "owner", scope: "erase" })).json()).toEqual({ deleted: 0, failed: 0 });
  });

  it("keeps a conversation whose team thread couldn't be deleted, so a retry finishes it", async () => {
    const { app, service, relay } = setup();
    const owner = await chat(app, service, { sub: "owner", account: "owner" });

    relay.failDeletes = true;
    const failed = await erase(app, { sub: "owner", account: "owner", scope: "erase" });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ deleted: 0, failed: 1 });
    expect(service.get(owner.id)).toBeDefined();

    relay.failDeletes = false;
    const retried = await erase(app, { sub: "owner", account: "owner", scope: "erase" });
    expect(retried.status).toBe(200);
    expect(service.get(owner.id)).toBeUndefined();
  });

  it("still deletes a conversation whose team thread is already gone", async () => {
    const { app, service, relay } = setup();
    const owner = await chat(app, service, { sub: "owner", account: "owner" });
    relay.vanish(owner.threadId);
    expect(await (await erase(app, { sub: "owner", account: "owner", scope: "erase" })).json()).toEqual({ deleted: 1, failed: 0 });
  });

  it("only takes an erase token signed with the shared secret", async () => {
    const { app, service } = setup();
    const owner = await chat(app, service, { sub: "owner", account: "owner" });

    // A widget's sign-in token, a forged one, and none at all.
    expect((await erase(app, { sub: "owner", account: "owner" })).status).toBe(401);
    const forged = signUserToken({ sub: "owner", account: "owner", scope: "erase" }, "wrong-secret-wrong-secret-wrong!");
    expect((await app.request("/api/erase", { method: "POST", headers: { Authorization: `Bearer ${forged}` } })).status).toBe(401);
    expect((await app.request("/api/erase", { method: "POST" })).status).toBe(401);
    expect(service.get(owner.id)).toBeDefined();

    // And an erase token doesn't sign anyone in.
    const eraseToken = signUserToken({ sub: "owner", scope: "erase" }, SECRET);
    expect(verifyUserToken(eraseToken, SECRET)).toBeNull();
    expect(verifyEraseToken(eraseToken, SECRET)).toEqual({ userId: "owner", account: null });
    expect(verifyEraseToken(signUserToken({ sub: "owner" }, SECRET), SECRET)).toBeNull();
  });
});
