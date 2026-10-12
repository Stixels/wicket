import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { Agent } from "../src/agent/agent.js";
import { ConversationService } from "../src/conversations.js";
import { createServer } from "../src/server.js";
import { FakeClient, FakeRelay, text } from "./helpers.js";

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

function setup(responses: any[] = []) {
  const db = openDb(":memory:");
  const client = new FakeClient(responses);
  const relay = new FakeRelay();
  const service = new ConversationService(db, new Agent(client, { model: "claude-haiku-5-5", effort: "low", maxSteps: 4, productName: "ED", productDescription: "" }), relay, () => {});
  void relay.start(({ threadId, authorName, body, files }) => service.handleStaffReply(threadId, authorName, body, files));
  const app = createServer(service, { allowedOrigins: [], maxConversationsPerIpPerHour: 50, maxMessagesPerConversationPerHour: 50 });
  return { client, relay, service, app };
}

async function start(app: ReturnType<typeof createServer>) {
  const res = await app.request("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  return (await res.json()) as { id: string; token: string };
}

function upload(app: ReturnType<typeof createServer>, conv: { id: string; token: string }, data: Buffer, name: string, type: string) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(data)], name, { type }));
  return app.request(`/api/conversations/${conv.id}/files`, { method: "POST", headers: { Authorization: `Bearer ${conv.token}` }, body: form });
}

const send = (app: ReturnType<typeof createServer>, conv: { id: string; token: string }, body: object) =>
  app.request(`/api/conversations/${conv.id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${conv.token}` },
    body: JSON.stringify(body),
  });

describe("attachments", () => {
  it("uploads a screenshot, shows it to the model and sends it to the team", async () => {
    const { app, client, relay, service } = setup([text("That error means the room has no start puzzle.")]);
    const conv = await start(app);
    const up = await upload(app, conv, PNG, "../../error.png", "image/png");
    expect(up.status).toBe(201);
    const { file } = (await up.json()) as { file: { id: string; name: string; url: string } };
    expect(file.name).toBe("error.png");

    const res = await send(app, conv, { body: "", attachments: [file.id] });
    expect(res.status).toBe(201);
    await service.idle(conv.id);

    // The message carries the file, and only once.
    expect(service.list(conv.id)[0]!.attachments).toEqual([{ id: file.id, name: "error.png", type: "image/png", size: PNG.length }]);
    expect((await send(app, conv, { body: "", attachments: [file.id] })).status).toBe(400);

    // The model saw the image itself.
    const content = client.requests[0].messages[0].content;
    expect(content.some((b: any) => b.type === "image" && b.source.data === PNG.toString("base64"))).toBe(true);

    // The team got the file in the thread.
    expect([...relay.threads.values()][0]!.posts).toContain(`user:  [file error.png ${PNG.length}B]`);

    // Anyone with the link can open it, with headers that keep it inert.
    const served = await app.request(file.url);
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toBe("image/png");
    expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(Buffer.from(await served.arrayBuffer())).toEqual(PNG);
  });

  it("refuses files a browser could run, and files that are too big", async () => {
    const { app } = setup();
    const conv = await start(app);
    expect((await upload(app, conv, Buffer.from("<svg onload=alert(1)>"), "x.svg", "image/svg+xml")).status).toBe(415);
    expect((await upload(app, conv, Buffer.from("<script>"), "x.html", "text/html")).status).toBe(415);
    expect((await upload(app, conv, Buffer.alloc(11 * 1024 * 1024), "big.pdf", "application/pdf")).status).toBe(413);
    expect((await app.request("/files/nope/x")).status).toBe(404);
  });

  it("tells the model about files it can't open, and passes team files back to the widget", async () => {
    const { app, client, relay, service } = setup([text("Thanks, I've passed the log to the team.")]);
    const conv = await start(app);
    const { file } = (await (await upload(app, conv, Buffer.from("line 1"), "console.log.txt", "text/plain")).json()) as { file: { id: string } };
    await send(app, conv, { body: "Here's the log", attachments: [file.id] });
    await service.idle(conv.id);
    const blocks = client.requests[0].messages[0].content.map((b: any) => b.text ?? b.type);
    expect(blocks).toContain("[The user attached console.log.txt (text/plain, 6 B). You can't open it, but the team can.]");

    await relay.staffReply([...relay.threads.keys()][0]!, "", [{ name: "fix.png", type: "image/png", data: PNG }]);
    const staff = service.list(conv.id).at(-1)!;
    expect(staff.author).toBe("staff");
    expect(staff.attachments[0]).toMatchObject({ name: "fix.png", type: "image/png" });
    expect((await app.request(`/files/${staff.attachments[0]!.id}/fix.png`)).status).toBe(200);
  });
});
