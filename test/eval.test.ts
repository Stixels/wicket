import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { backlogSchema, caseSchema, grade, linksIn } from "../src/eval/grade.js";
import { EvalTracker } from "../src/eval/tracker.js";
import { runCase } from "../src/eval/run.js";
import { openDb } from "../src/db/index.js";
import { parseSettings } from "../src/settings.js";
import { FakeClient, text, toolCall } from "./helpers.js";

const c = (kind: string, extra: object = {}) => caseSchema.parse({ id: 1, kind, question: "q", ...extra });
const DOCS = "https://docs.escapedirector.com";

describe("eval grading", () => {
  it("loads every case in evals/cases.yaml", () => {
    const { cases, backlog } = parse(readFileSync("evals/cases.yaml", "utf8"));
    const ids = cases.map((x: unknown) => caseSchema.parse(x).id);
    expect(ids).toHaveLength(39);
    expect(new Set(ids).size).toBe(ids.length);
    // Every route: add case points at a ticket that's in the backlog.
    const keys = new Set(backlog.map((b: unknown) => backlogSchema.parse(b).key));
    for (const c of cases.filter((x: any) => x.route === "add")) expect(keys).toContain(c.key);
  });

  it("answer: needs the expected link and no handoff", () => {
    const k = c("answer", { links: ["build-your-rooms/configure-live-view"] });
    expect(grade(k, { reply: `See [Live View](${DOCS}/build-your-rooms/configure-live-view#timer).`, handedOff: false }).pass).toBe(true);
    expect(grade(k, { reply: `See [Media](${DOCS}/build-your-rooms/manage-room-media).`, handedOff: false }).why).toEqual([
      "no link to build-your-rooms/configure-live-view",
    ]);
    expect(grade(k, { reply: `${DOCS}/build-your-rooms/configure-live-view`, handedOff: true }).why).toEqual(["handed off"]);
  });

  it("handoff, bug and idea", () => {
    expect(grade(c("handoff"), { reply: "", handedOff: true }).pass).toBe(true);
    expect(grade(c("handoff"), { reply: "Try again", handedOff: false }).pass).toBe(false);
    expect(grade(c("bug"), { reply: "Thanks, the team will look.", handedOff: false }).pass).toBe(false);
    const idea = c("idea", { mentions: ["voice"] });
    expect(grade(idea, { reply: "So: send clues as Voice recordings. Thanks!", handedOff: false }).pass).toBe(true);
    expect(grade(idea, { reply: "Thanks!", handedOff: false }).pass).toBe(false);
    const elsewhere = "Voice clues, got it. I don't have a way to log feature requests, so send it through the team's feedback channel.";
    expect(grade(idea, { reply: elsewhere, handedOff: false }).why).toEqual(["sent the user elsewhere instead of taking the idea"]);
    expect(grade(c("bug"), { reply: "Which page were you on when it froze?", handedOff: false }).pass).toBe(false);
    expect(grade(c("bug"), { reply: "Which room was running, and does it happen every time?", handedOff: false }).pass).toBe(true);
  });

  it("decline: short, no code", () => {
    expect(grade(c("decline"), { reply: "I can only help with Escape Director here. What do you need with it?", handedOff: false }).pass).toBe(true);
    expect(grade(c("decline"), { reply: "```py\nprint(1)\n```", handedOff: false }).why).toContain("wrote code");
    expect(grade(c("decline"), { reply: "x".repeat(401), handedOff: false }).why).toEqual(["reply is 401 characters"]);
  });

  it("code: says it can't write code and links a guide, with no code block", () => {
    const k = c("code", { links: ["build-your-own-controller", "escape-director-device-sdk"] });
    const good = `I'm not set up to write code here, but [Build Your Own Controller](${DOCS}/build-your-rooms/build-your-own-controller) walks through it with a coding agent.`;
    expect(grade(k, { reply: good, handedOff: false }).pass).toBe(true);
    expect(grade(k, { reply: "I can’t write the sketch for you; see https://github.com/directorhq/escape-director-device-sdk/blob/main/examples/room_basic/room_basic.ino", handedOff: false }).pass).toBe(true);
    expect(grade(k, { reply: `Here you go:\n\`\`\`cpp\nroom.begin();\n\`\`\`\n${good}`, handedOff: false }).why).toEqual(["wrote code"]);
    expect(grade(k, { reply: `Use the SDK: ${DOCS}/build-your-rooms/build-your-own-controller`, handedOff: false }).why).toEqual([
      "didn't say it can't write code",
    ]);
  });

  it("hardware: bundled boards plus other boards or MQTT devices, with a link", () => {
    const k = c("hardware", { links: ["connect-existing-devices", "BOARD_PORTING"] });
    const good = `The SDK includes adapters for the UNO R4 WiFi and GIGA R1 WiFi, and a prop that already speaks MQTT can [connect as an existing device](${DOCS}/build-your-rooms/connect-existing-devices).`;
    expect(grade(k, { reply: good, handedOff: false }).pass).toBe(true);
    expect(grade(k, { reply: "It supports the UNO R4 WiFi and GIGA R1 WiFi.", handedOff: false }).why).toEqual([
      "didn't say other boards or MQTT/HTTP devices work",
      "no link to connect-existing-devices or BOARD_PORTING",
    ]);
  });

  it("finds markdown and bare links", () => {
    expect(linksIn("See [a](https://x.com/a) and https://y.com/b.")).toEqual(["https://x.com/a", "https://y.com/b"]);
  });

  it("route: checks what was filed or added to, and that no ticket key reaches the person", () => {
    const none = { filed: [], added: [] };
    const filed = (kind: any, title = "Video upload stuck at 99%", description = "Uploading an mp4 stops at 99%.") => ({ filed: [{ key: "ED-901", title, kind, description }], added: [] });
    const add = c("route", { route: "add", key: "ED-101" });
    expect(grade(add, { reply: "Thanks, I've added your report.", handedOff: false, tickets: { filed: [], added: ["ED-101"] } }).pass).toBe(true);
    expect(grade(add, { reply: "Thanks.", handedOff: false, tickets: { filed: [], added: ["ED-108"] } }).why).toEqual(["should add to ED-101, but added to ED-108"]);
    expect(grade(add, { reply: "Thanks.", handedOff: false, tickets: filed("bug") }).why).toEqual(['should add to ED-101, but filed bug "Video upload stuck at 99%"']);
    expect(grade(add, { reply: "Added to ED-101.", handedOff: false, tickets: { filed: [], added: ["ED-101"] } }).why).toEqual(["told the user a ticket key"]);

    const file = c("route", { route: "file", ticketKinds: ["bug"], mentions: ["99"] });
    expect(grade(file, { reply: "Logged it.", handedOff: false, tickets: filed("bug") }).pass).toBe(true);
    expect(grade(file, { reply: "Logged it.", handedOff: false, tickets: filed("feature") }).why).toEqual(["filed as feature, expected bug"]);
    expect(grade(file, { reply: "Logged it.", handedOff: false, tickets: filed("bug", "Upload fails", "It fails.") }).why).toEqual(["ticket doesn't mention 99"]);
    expect(grade(file, { reply: "Thanks!", handedOff: false, tickets: none }).why).toEqual(["should file one new ticket, but logged nothing"]);
    const twice = { filed: [...filed("bug").filed, { ...filed("bug").filed[0]!, key: "ED-902" }], added: [] };
    expect(grade(file, { reply: "Logged it.", handedOff: false, tickets: twice }).pass).toBe(false);

    const leave = c("route", { route: "none" });
    expect(grade(leave, { reply: "Open the puzzle and add a clue.", handedOff: false, tickets: none }).pass).toBe(true);
    expect(grade(leave, { reply: "Logged it.", handedOff: false, tickets: filed("docs") }).pass).toBe(false);
    expect(() => c("route", { route: "add" })).toThrow();
  });
});

describe("eval tracker", () => {
  it("searches the backlog by shared words and records what was filed and added to", async () => {
    const t = new EvalTracker([
      { key: "ED-101", kind: "bug", title: "Room timer drifts behind after pausing a game" },
      { key: "ED-104", kind: "feature", title: "Send clues as voice recordings" },
    ]);
    expect((await t.search("timer pause drift", 5)).map((x) => x.key)).toEqual(["ED-101"]);
    expect((await t.search("the and with", 5))).toEqual([]);
    expect((await t.get("ed-104"))?.title).toBe("Send clues as voice recordings");
    await t.comment("ED-101", "another report");
    const made = await t.create({ title: "Upload stuck", kind: "bug", description: "d" });
    expect(made.key).toBe("ED-901");
    expect((await t.search("upload", 5)).map((x) => x.key)).toEqual(["ED-901"]);
    expect(t.log).toEqual({ filed: [{ key: "ED-901", title: "Upload stuck", kind: "bug", description: "d" }], added: ["ED-101"] });
  });
});

describe("runCase", () => {
  const backlog = [{ key: "ED-101", kind: "bug" as const, title: "Room timer drifts behind after pausing a game" }];
  const agent = { model: "claude-haiku-5-5", effort: "low" as const, maxSteps: 6, productName: "Escape Director", productDescription: "" };

  it("runs a chat through the real conversation code and scores what reached the tracker", async () => {
    const models = new FakeClient([
      text("Sorry about that. Does it happen every time you pause?"),
      toolCall("find_tickets", { query: "timer pause drift" }, "a1"),
      toolCall("add_to_ticket", { key: "ED-101", kind: "bug", note: "Every game.", user_summary: "the timer falling behind after a pause" }, "a2"),
      text("Thanks, that's gone straight to the team and you'll hear back here when it's fixed."),
    ]);
    const k = c("route", { question: "The timer falls behind after I pause", then: ["Every game."], route: "add", key: "ED-101" });
    const r = await runCase(k, { db: openDb(":memory:"), models, agent, settings: parseSettings(""), backlog });
    expect(r.why).toEqual([]);
    expect(r.outcome.tickets).toEqual({ filed: [], added: ["ED-101"] });
    expect(r.toolCalls).toBe(2);
    expect(r.outcome.reply).toContain("Does it happen every time");
    // The model saw the backlog through find_tickets, as in the app.
    expect(models.requests[2].messages.at(-1).content[0].output.value).toBe("ED-101: Room timer drifts behind after pausing a game");
  });

  it("starts each run from a clean backlog, even when tickets are off in settings", async () => {
    const db = openDb(":memory:");
    const settings = parseSettings("tickets:\n  assistant: false\n");
    const file = () =>
      new FakeClient([
        toolCall("file_ticket", { title: "Upload stuck at 99%", kind: "bug", description: "Stops at 99%.", user_summary: "uploads stopping at 99%" }, "f1"),
        text("Logged, thanks."),
      ]);
    const k = c("route", { route: "file", ticketKinds: ["bug"], mentions: ["99"] });
    expect((await runCase(k, { db, models: file(), agent, settings, backlog })).pass).toBe(true);
    const again = await runCase(k, { db, models: file(), agent, settings, backlog });
    expect(again.outcome.tickets.filed.map((f) => f.key)).toEqual(["ED-901"]);
  });

  it("raises a model error instead of scoring it as a handoff", async () => {
    await expect(runCase(c("answer"), { db: openDb(":memory:"), models: new FakeClient([]), agent, settings: parseSettings(""), backlog })).rejects.toThrow("no more scripted responses");
  });
});
