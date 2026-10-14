import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { ConversationService } from "../src/conversations.js";
import { createServer } from "../src/server.js";
import { signUserToken } from "../src/identity.js";

const SECRET = "test-secret-test-secret-test-secret!";

function setup() {
  const service = new ConversationService(openDb(":memory:"), null, null, () => {});
  const app = createServer(service, { allowedOrigins: [], maxConversationsPerIpPerHour: 50, maxMessagesPerConversationPerHour: 50, identitySecret: SECRET });
  return { service, app };
}

const post = (app: ReturnType<typeof setup>["app"], path: string, body: object) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function start(app: ReturnType<typeof setup>["app"], userToken?: string) {
  const res = await post(app, "/api/conversations", { reporter: {}, ...(userToken ? { userToken } : {}) });
  return (await res.json()) as { id: string; token: string };
}

describe("history across devices", () => {
  it("returns a signed-in user's conversations from any device, with tokens only for their own", async () => {
    const { app } = setup();
    const sam = signUserToken({ sub: "sam" }, SECRET);
    const a = await start(app, sam);
    const b = await start(app, sam);
    const other = await start(app, signUserToken({ sub: "alex" }, SECRET));
    const anon = await start(app);

    // A new device: nothing stored locally, just the sign-in.
    const res = await post(app, "/api/conversations/summaries", { conversations: [], userToken: signUserToken({ sub: "sam" }, SECRET) });
    const list = (await res.json()).conversations as { id: string; token?: string }[];
    expect(list.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(list.find((c) => c.id === a.id)!.token).toBe(a.token);

    // Conversations kept in this browser still come back, without their token being echoed.
    const mixed = (await (await post(app, "/api/conversations/summaries", { conversations: [anon], userToken: sam })).json()).conversations;
    expect(mixed.map((c: any) => c.id).sort()).toEqual([a.id, b.id, anon.id].sort());
    expect(mixed.find((c: any) => c.id === anon.id).token).toBeUndefined();
    expect(mixed.some((c: any) => c.id === other.id)).toBe(false);
  });

  it("ignores a forged or missing sign-in", async () => {
    const { app } = setup();
    await start(app, signUserToken({ sub: "sam" }, SECRET));
    for (const userToken of [signUserToken({ sub: "sam" }, "wrong-secret-wrong-secret-wrong!"), undefined]) {
      const list = (await (await post(app, "/api/conversations/summaries", { conversations: [], userToken })).json()).conversations;
      expect(list).toEqual([]);
    }
  });
});
