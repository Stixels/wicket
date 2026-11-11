// Local demo with no API keys: indexes the real docs, scripted model, simulated Discord.
// npm run demo, then open http://localhost:4317 . POST /__staff {"body":"..."} simulates a team reply.
import { serve } from "@hono/node-server";
import { openDb } from "../src/db/index.js";
import { Agent } from "../src/agent/agent.js";
import { ConversationService } from "../src/conversations.js";
import { createServer } from "../src/server.js";
import { reindex, searchDocs } from "../src/knowledge/index.js";
import { MarkdownRepoSource } from "../src/adapters/knowledge/markdownRepo.js";
import { MockLanguageModelV4 } from "ai/test";
import { FakeRelay } from "../test/helpers.js";
import { loadSettings } from "../src/settings.js";
import { signUserToken } from "../src/identity.js";
import { TicketDesk } from "../src/tickets.js";
import { EvalTracker } from "../src/eval/tracker.js";

// Profiles from config/wicket.yaml. ?as=visitor shows the page signed out; ?path=/app/analytics pretends to be on that page.
const SECRET = "demo-secret-demo-secret-demo-secret!";

const db = openDb(":memory:");
const n = await reindex(db, [new MarkdownRepoSource({ repo: process.env.DOCS_GITHUB_REPO ?? "directorhq/escape-director-documentation", baseUrl: process.env.DOCS_BASE_URL ?? "https://docs.escapedirector.com" })]);
console.log("indexed sections:", n);
for (const q of ["How do I add a clue to a puzzle?", "invite a game master"]) {
  console.log(q, "=>", searchDocs(db, q, 2).map((h) => `${h.title} > ${h.heading}`));
}
// Scripted model: search with the user's words, then answer with the top hit.
const said = (m: any) => m.content.filter((c: any) => c.type === "text" && !/^<(app_context|recent_activity)>/.test(c.text)).map((c: any) => c.text).join("\n");
const docLink = (out: any) => {
  const hit = String(typeof out?.value === "string" ? out.value : JSON.stringify(out?.value ?? "")).split("\n");
  return `[${hit[0].replace(/^## /, "")}](${hit[1]})`;
};
const BROKEN = /\b(isn't|aren't|doesn't|don't|won't|stopp?(ed|s)?|broken|blank|wrong|jumps?|resets?|not (showing|working))\b/i;
// The way a model rewords a problem into a search for a known fix.
const troubleshoot = (q: string) => `troubleshoot ${q.match(/\b(clues?|tv|timer|screen|sound|audio|media|connection|lights?)\b/gi)?.join(" ") ?? q}`;
const toolName = (m: any) => m.content[0]?.toolName;
// The steps the app noted (Wicket.addBreadcrumb) in the trail the widget sent with the report.
const breadcrumbs = (prompt: any[]) => {
  const block = prompt.flatMap((m: any) => (m.role === "user" ? m.content : [])).find((c: any) => c.type === "text" && c.text.startsWith("<recent_activity>"));
  return block ? [...block.text.matchAll(/^- [\dms ]+ before: (?!opened |clicked |error: )(.+)$/gm)].map((m: any) => m[1]) : [];
};
const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
const file = (kind: string, first: string, description: string) => ({
  finish: "tool-calls",
  tool: { id: `f${Date.now()}`, name: "file_ticket", input: { title: first.slice(0, 78), kind, description, user_summary: lower(first).replace(/[.!]$/, "") } },
});
// A report from a widget shortcut. Bug: offer a fix from the docs and propose the steps from the trail,
// then file it with the steps they confirmed, unless they say the fix worked. Feature: ask what it's for, then file it.
const reportReply = (prompt: any[]) => {
  const last = prompt.at(-1);
  const users = prompt.filter((m: any) => m.role === "user").map(said).filter(Boolean);
  const bug = prompt.some((m: any) => m.role === "system" && String(m.content).includes('chose "Report a bug"'));
  const asked = prompt.some((m: any) => m.role === "assistant" && JSON.stringify(m.content).includes("does it happen every time"));
  const steps = breadcrumbs(prompt);
  const find = { finish: "tool-calls", tool: { id: `t${Date.now()}`, name: "find_tickets", input: { query: users[0].slice(0, 60) } } };
  if (last.role === "tool") {
    const out = last.content[0]?.output;
    if (toolName(last) === "search_docs") {
      const propose = steps.length
        ? `Looks like you ${steps.map(lower).join(", then ")}. Is that right, and does it happen every time?`
        : "What did you do just before, and does it happen every time?";
      return { finish: "stop", text: `Sorry about that. If it's the TV, ${docLink(out)} has a fix that often sorts it out. ${propose}` };
    }
    if (toolName(last) === "find_tickets") {
      if (!bug) return file("feature", users[0], `${users[0]}\n\n${users.slice(1).join("\n")}`);
      const confirmed = steps.length ? `${steps.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}\n\nConfirmed by the reporter: "${users.at(-1)}"` : users.slice(1).join("\n");
      return file("bug", users[0], `${users[0]}\n\n## Steps to reproduce\n${confirmed}\n\n## Context\nPage and app version from the widget.`);
    }
    return { finish: "stop", text: String(out?.value ?? "").startsWith("Filed") ? (bug ? "Thanks, that's everything I need. It's gone straight to the team, and you'll hear back here when it's fixed." : "Thanks! It's gone straight to the team, and you'll hear back here once they've decided.") : "Thanks, I've passed that on." };
  }
  const now = users.at(-1)!;
  if (!bug) return users.length > 1 ? find : { finish: "stop", text: "Nice idea. What would you use it for?" };
  if (!asked) return { finish: "tool-calls", tool: { id: `s${Date.now()}`, name: "search_docs", input: { query: troubleshoot(now) } } };
  if (/\b(fixed|worked|that did it|sorted)\b/i.test(now) && !/\b(not|didn't|still)\b/i.test(now)) return { finish: "stop", text: "Glad that sorted it! I won't file anything, but tell me here if it comes back." };
  return find;
};
// Ordinary chat: search and answer with the top hit. Something broken is logged right away, as the assistant does on its own.
const reply = (prompt: any[]) => {
  const last = prompt.at(-1);
  const q = said(prompt.filter((m: any) => m.role === "user").at(-1));
  if (last.role === "tool") {
    if (toolName(last) === "search_docs" && BROKEN.test(q)) return { finish: "tool-calls", tool: { id: `t${Date.now()}`, name: "find_tickets", input: { query: q.slice(0, 60) } } };
    if (toolName(last) === "find_tickets") return file("bug", q, `${q}\n\n## Context\nPage and app version from the widget.`);
    if (toolName(last) === "file_ticket") return { finish: "stop", text: "Sorry about that. I've logged it for the team, and you'll hear back here when it's fixed." };
    return { finish: "stop", text: `Here's the guide that covers it: ${docLink(last.content[0]?.output)}. Let me know if that doesn't do it.` };
  }
  if (/snippet|script|code/i.test(q)) return { finish: "stop", text: "From the SDK's MQTT example, publish the win like this:\n\n```python\nfrom escape_director import Device\n\ndevice = Device.from_env()\n\ndef on_win():\n    device.signal(\"tictactoe.won\", {\"board\": \"A\"})  # maps to a signal in Escape Director\n```\n\nThen map `tictactoe.won` to **Complete a puzzle** on the device page." };
  if (/person|human|refund/i.test(q)) return { finish: "tool-calls", tool: { id: "h1", name: "handoff_to_human", input: { reason: q } } };
  return { finish: "tool-calls", tool: { id: `s${Date.now()}`, name: "search_docs", input: { query: BROKEN.test(q) ? troubleshoot(q) : q } } };
};
const client = {
  languageModel: (id: string) =>
    new MockLanguageModelV4({
      modelId: id,
      doGenerate: async (options: any) => {
        const guided = options.prompt.some((m: any) => m.role === "system" && /chose "(Report a bug|Request a feature)"/.test(String(m.content)));
        const r: any = guided ? reportReply(options.prompt) : reply(options.prompt);
        return {
          content: r.tool
            ? [{ type: "tool-call" as const, toolCallId: r.tool.id, toolName: r.tool.name, input: JSON.stringify(r.tool.input) }]
            : [{ type: "text" as const, text: r.text }],
          finishReason: { unified: r.finish, raw: r.finish },
          usage: { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: undefined, reasoning: undefined } },
          warnings: [],
        };
      },
    }),
};
const relay = new FakeRelay();
// An in-memory tracker, so report shortcuts work without Linear or GitHub.
const tracker = new EvalTracker([{ key: "ED-101", kind: "bug", title: "Room timer drifts behind after pausing and resuming a game" }]);
const tickets = new TicketDesk(db, tracker, { notify: (n) => service.ticketNews(n), log: console.error });
const service = new ConversationService(db, new Agent(client, { model: "x", effort: "low", maxSteps: 4, productName: "Escape Director", productDescription: "" }), relay, { settings: loadSettings(), log: console.error, tickets });
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
<body><main><h1>Escape Director</h1><p>Demo host page for the help widget.</p>
<div class="card"><b id="where">Rooms</b> · <span id="state">Live session running</span>
<p><button id="dash">Room Dashboard</button> <button id="pause">Pause game</button> <button id="clue">Send Clue</button> <input placeholder="Clue text (never recorded)"></p></div></main>
<script>
// The host app's own steps, for the trail that goes with a bug report.
document.getElementById("dash").onclick = () => { history.pushState({}, "", "/rooms/treehouse/dashboard"); document.getElementById("where").textContent = "The Treehouse · Room Dashboard"; };
document.getElementById("pause").onclick = (e) => { const paused = e.target.textContent === "Pause game"; e.target.textContent = paused ? "Resume" : "Pause game"; document.getElementById("state").textContent = paused ? "Paused" : "Live session running"; Wicket.addBreadcrumb(paused ? "Paused the game" : "Resumed the game"); };
document.getElementById("clue").onclick = () => { Wicket.addBreadcrumb("Sent a Clue from the Room Dashboard"); console.error("TypeError: Cannot read properties of undefined (reading 'clueCount')"); };
</script>
<script src="/widget.js"></script><script>Wicket.init({ ${q.as === "visitor" ? "" : `userToken: ${JSON.stringify(signUserToken({ sub: "u1", name: "Sam (Treehouse Escape)", plan: q.plan }, SECRET, 3600))},`}
  context: { appVersion: "2.3.0"${q.path ? `, path: ${JSON.stringify(q.path)}` : ""} },
  title: "Escape Director Support", launcherLabel: ${JSON.stringify(q.label ?? "")},
  theme: ${JSON.stringify(theme)} }); ${q.closed ? "" : "Wicket.open();"}</script></body></html>`);
});
// What landed in the in-memory tracker: GET /__tickets.
app.get("/__tickets", (c) => c.json(tracker.log.filed.map((f) => ({ ...f, comments: tracker.commentsOn(f.key) }))));
app.post("/__staff", async (c) => { const { body } = await c.req.json(); const thread = [...relay.threads.keys()].at(-1)!; await relay.staffReply(thread, body); return c.json({ ok: true, posts: relay.threads.get(thread)?.posts }); });
serve({ fetch: app.fetch, port: 4317 }, () => console.log("ready on 4317"));
