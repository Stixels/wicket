// Local demo with no API keys: indexes the real docs, scripted model, simulated Discord.
// npm run demo, then open http://localhost:4317 . POST /__staff {"body":"..."} simulates a team reply.
import { serve } from "@hono/node-server";
import { openDb } from "../src/db/index.js";
import { Agent } from "../src/agent/agent.js";
import { ConversationService } from "../src/conversations.js";
import { createServer } from "../src/server.js";
import { reindex, searchDocs } from "../src/knowledge/index.js";
import { MarkdownRepoSource } from "../src/adapters/knowledge/markdownRepo.js";
import { FakeRelay } from "../test/helpers.js";

const db = openDb(":memory:");
const n = await reindex(db, [new MarkdownRepoSource({ repo: process.env.DOCS_GITHUB_REPO ?? "directorhq/escape-director-documentation", baseUrl: process.env.DOCS_BASE_URL ?? "https://docs.escapedirector.com" })]);
console.log("indexed sections:", n);
for (const q of ["How do I add a clue to a puzzle?", "invite a game master"]) {
  console.log(q, "=>", searchDocs(db, q, 2).map((h) => `${h.title} > ${h.heading}`));
}
// Scripted model: search with the user's words, then answer with the top hit.
const client = {
  beta: { messages: { create: async (p: any) => {
    const last = p.messages.at(-1);
    if (last.content[0]?.type === "tool_result") {
      const hit = String(last.content[0].content).split("\n");
      return { stop_reason: "end_turn", content: [{ type: "text", text: `Here's the guide that covers it: [${hit[0].replace(/^## /, "")}](${hit[1]}). Let me know if that doesn't do it.` }] };
    }
    const q = last.content.at(-1).text;
    if (/person|human|refund/i.test(q)) return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "h1", name: "handoff_to_human", input: { reason: q } }] };
    return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "s1", name: "search_docs", input: { query: q } }] };
  } } },
};
const relay = new FakeRelay();
const service = new ConversationService(db, new Agent(client as any, { model: "x", effort: "low", maxSteps: 4, productName: "Escape Director", productDescription: "" }), relay, console.error);
await relay.start((r) => service.handleStaffReply(r.threadId, r.authorName, r.body));
(globalThis as any).relay = relay;
const app = createServer(service, { allowedOrigins: [], maxConversationsPerIpPerHour: 50, maxMessagesPerConversationPerHour: 50 });
app.get("/", (c) => c.html(`<!doctype html><html><head><title>Escape Director (demo)</title></head><body style="font-family:system-ui;margin:40px">
<h1>Escape Director</h1><p>Demo host page for the feedback widget.</p>
<script src="/widget.js"></script><script>FeedbackLoop.init({ user: { id: "u1", name: "Sam (Treehouse Escape)" }, context: { appVersion: "2.3.0" } }); FeedbackLoop.open();</script></body></html>`));
app.post("/__staff", async (c) => { const { body } = await c.req.json(); await relay.staffReply("thread_1", body); return c.json({ ok: true, posts: relay.threads.get("thread_1")?.posts }); });
serve({ fetch: app.fetch, port: 4317 }, () => console.log("ready on 4317"));
