// A scripted stand-in for the model, for `npm run demo` and for the hosted demo when no AI key is set.
// It searches the docs with the person's words and answers with the top hit, logs bugs and ideas
// the way the assistant would, and costs nothing.
import { MockLanguageModelV4 } from "ai/test";
import type { ModelProvider } from "../agent/agent.js";

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
export const scriptedModels: ModelProvider = {
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
