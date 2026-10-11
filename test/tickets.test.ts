import { afterEach, describe, expect, it, vi } from "vitest";
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
        : {
            teams: { nodes: [{ id: "team1", states: { nodes: [{ id: "todo", type: "unstarted", position: 1 }, { id: "backlog", type: "backlog", position: 0 }] }, labels: { nodes: [{ id: "lbug", name: "Bug" }] } }] },
            issueLabels: { nodes: [{ id: "lsrc", name: "Source: Discord", team: null }] },
          };
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    const t = new LinearTracker({ apiKey: "k", teamKey: "ED", sourceLabel: "Source: Discord" });
    expect(await t.create({ title: "Timer stops", description: "d", kind: "bug" })).toEqual({ key: "ED-42", url: "https://linear.app/x/issue/ED-42" });
    expect(calls[1].variables.input).toEqual({ teamId: "team1", title: "Timer stops", description: "d", labelIds: ["lbug", "lsrc"], stateId: "backlog" });
    await t.create({ title: "Dark mode", description: "d", kind: "feature" }); // team is cached, "Feature" label missing is skipped
    expect(calls).toHaveLength(3);
    expect(calls[2].variables.input.labelIds).toEqual(["lsrc"]);
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
