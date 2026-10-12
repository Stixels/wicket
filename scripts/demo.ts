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
import { loadSettings } from "../src/settings.js";
import { signUserToken } from "../src/identity.js";

// Profiles from config/wicket.yaml. ?as=visitor shows the page signed out; ?path=/app/analytics pretends to be on that page.
const SECRET = "demo-secret-demo-secret-demo-secret!";

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
    if (/snippet|script|code/i.test(q)) return { stop_reason: "end_turn", content: [{ type: "text", text: "From the SDK's MQTT example, publish the win like this:\n\n```python\nfrom escape_director import Device\n\ndevice = Device.from_env()\n\ndef on_win():\n    device.signal(\"tictactoe.won\", {\"board\": \"A\"})  # maps to a signal in Escape Director\n```\n\nThen map `tictactoe.won` to **Complete a puzzle** on the device page." }] };
    if (/person|human|refund/i.test(q)) return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "h1", name: "handoff_to_human", input: { reason: q } }] };
    return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "s1", name: "search_docs", input: { query: q } }] };
  } } },
};
const relay = new FakeRelay();
const service = new ConversationService(db, new Agent(client as any, { model: "x", effort: "low", maxSteps: 4, productName: "Escape Director", productDescription: "" }), relay, { settings: loadSettings(), log: console.error });
await relay.start((r) => service.handleStaffReply(r.threadId, r.authorName, r.body));
(globalThis as any).relay = relay;
const app = createServer(service, { allowedOrigins: [], maxConversationsPerIpPerHour: 50, maxMessagesPerConversationPerHour: 50, identitySecret: SECRET });
app.get("/", (c) => {
  const q = c.req.query();
  // With no theme in the URL, the widget takes the theme from config/wicket.yaml.
  const theme = Object.fromEntries(Object.entries({ accentColor: q.accent ? `#${q.accent}` : undefined, mode: q.mode, position: q.position }).filter(([, v]) => v));
  return c.html(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Escape Director (demo)</title>
<style>body{margin:0;font-family:system-ui;background:${(q.mode ?? q.host) === "dark" ? "#0d0d10;color:#eee" : "#f4f1ec;color:#222"}} main{max-width:880px;margin:0 auto;padding:56px 24px}
.card{background:${(q.mode ?? q.host) === "dark" ? "#17171b" : "#fff"};border-radius:14px;padding:24px;margin-top:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}</style></head>
<body><main><h1>Escape Director</h1><p>Demo host page for the help widget.</p><div class="card">Room: The Treehouse · Live session idle</div></main>
<script src="/widget.js"></script><script>Wicket.init({ ${q.as === "visitor" ? "" : `userToken: ${JSON.stringify(signUserToken({ sub: "u1", name: "Sam (Treehouse Escape)", plan: q.plan }, SECRET, 3600))},`}
  context: { appVersion: "2.3.0"${q.path ? `, path: ${JSON.stringify(q.path)}` : ""} },
  title: "Escape Director Support", subtitle: "We usually reply in minutes", launcherLabel: ${JSON.stringify(q.label ?? "")},
  theme: ${JSON.stringify(theme)} }); ${q.closed ? "" : "Wicket.open();"}</script></body></html>`);
});
app.post("/__staff", async (c) => { const { body } = await c.req.json(); const thread = [...relay.threads.keys()].at(-1)!; await relay.staffReply(thread, body); return c.json({ ok: true, posts: relay.threads.get(thread)?.posts }); });
serve({ fetch: app.fetch, port: 4317 }, () => console.log("ready on 4317"));
