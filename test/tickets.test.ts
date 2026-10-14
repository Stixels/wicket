import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubIssuesTracker } from "../src/adapters/tracker/github.js";
import { LinearTracker } from "../src/adapters/tracker/linear.js";
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
  it("forces the create_ticket tool and returns its input", async () => {
    const create = vi.fn(async () => ({ content: [{ type: "tool_use", id: "t", name: "create_ticket", input: { title: "Timer stops", kind: "bug", description: "x" } }] }));
    const draft = await draftTicket({ messages: { create } } as any, "m", "Escape Director", "Sam: the timer stops", "bug please");
    expect(draft).toEqual({ title: "Timer stops", kind: "bug", description: "x" });
    expect((create.mock.calls[0] as any)[0].tool_choice).toEqual({ type: "tool", name: "create_ticket" });
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
    expect(await t.create({ title: "Timer stops", description: "d", kind: "bug" })).toEqual({ key: "#12", url: "https://github.com/o/r/issues/12" });
    expect(calls.at(-1)).toEqual({ url: "https://api.github.com/repos/o/r/issues", method: "POST", body: { title: "Timer stops", body: "d", labels: ["bug", "Triage"] } });
    await t.create({ title: "Dark mode", description: "d", kind: "feature" }); // labels cached, "enhancement" missing is skipped
    expect(calls.filter((c) => c.url.includes("/labels"))).toHaveLength(1);
    expect(calls.at(-1)!.body.labels).toEqual(["Triage"]);
  });

  it("reports GitHub's error message", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }));
    await expect(new GitHubIssuesTracker({ token: "bad", repo: "o/r" }).create({ title: "x", description: "d", kind: "bug" })).rejects.toThrow("GitHub: Bad credentials");
  });
});
