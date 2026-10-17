import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubIssuesTracker } from "../src/adapters/tracker/github.js";
import { LinearTracker } from "../src/adapters/tracker/linear.js";
import { MockLanguageModelV4 } from "ai/test";
import { draftTicket } from "../src/agent/tickets.js";

afterEach(() => vi.unstubAllGlobals());

describe("LinearTracker", () => {
  it("files into Backlog when the team has no Triage, with matching labels", async () => {
    const calls: any[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const data = body.query.includes("issueCreate")
        ? { issueCreate: { success: true, issue: { identifier: "ED-42", url: "https://linear.app/x/issue/ED-42" } } }
        : body.query.includes("teams(")
          ? { teams: { nodes: [{ id: "team1", states: { nodes: [{ id: "todo", name: "Todo", type: "unstarted", position: 1 }, { id: "backlog", name: "Backlog", type: "backlog", position: 0 }] } }] } }
          : { team: { labels: { nodes: [{ id: "lbug", name: "Bug" }] } }, issueLabels: { nodes: [{ id: "lsrc", name: "Source: Discord" }] } };
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const t = new LinearTracker({ apiKey: "k", teamKey: "ED", sourceLabel: "Source: Discord" });
    expect(await t.create({ title: "Timer stops", description: "d", kind: "bug" })).toEqual({ key: "ED-42", url: "https://linear.app/x/issue/ED-42" });
    expect(calls[2].variables.input).toEqual({ teamId: "team1", title: "Timer stops", description: "d", labelIds: ["lbug", "lsrc"], stateId: "backlog" });
    await t.create({ title: "Dark mode", description: "d", kind: "feature" }); // team is cached, "Feature" label missing is skipped
    expect(calls).toHaveLength(4);
    expect(calls[3].variables.input.labelIds).toEqual(["lsrc"]);
  });
});

describe("draftTicket", () => {
  it("asks for a ticket as structured output and returns it", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: "text", text: JSON.stringify({ title: "Timer stops", kind: "bug", description: "x" }) }],
        finishReason: { unified: "stop", raw: "end_turn" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
        warnings: [],
      },
    });
    const draft = await draftTicket(model, "Escape Director", "Sam: the timer stops", "bug please");
    expect(draft).toEqual({ title: "Timer stops", kind: "bug", description: "x" });
    const call = model.doGenerateCalls[0]!;
    expect(call.responseFormat).toMatchObject({ type: "json", name: "ticket" });
    expect(JSON.stringify(call.prompt)).toContain("bug please");
  });
});

describe("GitHubIssuesTracker", () => {
  it("files an issue with the repo's matching labels and skips missing ones", async () => {
    const calls: { url: string; method: string; body?: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
      if (url.includes("/labels")) return new Response(JSON.stringify([{ name: "bug" }, { name: "Triage" }]), { status: 200 });
      if (init.method === "POST") return new Response(JSON.stringify({ number: 12, html_url: "https://github.com/o/r/issues/12" }), { status: 201 });
      return new Response(JSON.stringify({ full_name: "o/r", has_issues: true }), { status: 200 });
    });
    const t = new GitHubIssuesTracker({ token: "t", repo: "o/r", sourceLabel: "triage" });
    expect(await t.check()).toBe("new tickets go to o/r");
    expect(await t.create({ title: "Timer stops", description: "d", kind: "bug" })).toEqual({ id: "12", key: "#12", url: "https://github.com/o/r/issues/12" });
    expect(calls.at(-1)).toEqual({ url: "https://api.github.com/repos/o/r/issues", method: "POST", body: { title: "Timer stops", body: "d", labels: ["bug", "Triage"] } });
    await t.create({ title: "Dark mode", description: "d", kind: "feature" }); // labels cached, "enhancement" missing is skipped
    expect(calls.filter((c) => c.url.includes("/labels"))).toHaveLength(1);
    expect(calls.at(-1)!.body.labels).toEqual(["Triage"]);
  });

  it("follows issues: search, lookup, comments, and done versus not planned with a Reply", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      urls.push(`${init.method} ${url}`);
      const issue = (number: number, state: string, state_reason: string | null) => ({ number, html_url: `https://github.com/o/r/issues/${number}`, title: `t${number}`, state, state_reason });
      if (url.includes("/search/issues")) return new Response(JSON.stringify({ items: [issue(3, "open", null)] }), { status: 200 });
      if (url.endsWith("/comments?per_page=100")) return new Response(JSON.stringify([{ body: "Reply: Out of scope for now.", created_at: "2026-10-14T00:00:00Z" }]), { status: 200 });
      if (init.method === "POST") return new Response("{}", { status: 201 });
      const n = Number(/issues\/(\d+)/.exec(url)![1]);
      if (n === 9) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      return new Response(JSON.stringify(n === 1 ? issue(1, "closed", "completed") : n === 2 ? issue(2, "closed", "not_planned") : issue(n, "open", null)), { status: 200 });
    });
    const t = new GitHubIssuesTracker({ token: "t", repo: "o/r" });
    expect((await t.search("timer: drift", 5)).map((x) => x.key)).toEqual(["#3"]);
    expect(urls[0]).toContain("/search/issues?q=repo%3Ao%2Fr%20is%3Aissue%20is%3Aopen%20timer%20%20drift");
    expect((await t.get("https://github.com/o/r/issues/3"))?.key).toBe("#3");
    expect(await t.get("#9")).toBeNull();
    expect(await t.get("ED-1")).toBeNull();
    await t.comment("3", "another report");
    expect(urls.at(-1)).toBe("POST https://api.github.com/repos/o/r/issues/3/comments");
    const states = await t.states(["1", "2", "#3", "9"]);
    expect(states.map((x) => `${x.id}:${x.state}:${x.reason ?? ""}`)).toEqual(["1:done:", "2:closed:Out of scope for now.", "#3:open:"]);
  });

  it("reports GitHub's error message", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }));
    await expect(new GitHubIssuesTracker({ token: "bad", repo: "o/r" }).create({ title: "x", description: "d", kind: "bug" })).rejects.toThrow("GitHub: Bad credentials");
  });
});
