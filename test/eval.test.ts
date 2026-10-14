import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { caseSchema, grade, linksIn } from "../src/eval/grade.js";

const c = (kind: string, extra: object = {}) => caseSchema.parse({ id: 1, kind, question: "q", ...extra });
const DOCS = "https://docs.escapedirector.com";

describe("eval grading", () => {
  it("loads every case in evals/cases.yaml", () => {
    const { cases } = parse(readFileSync("evals/cases.yaml", "utf8"));
    expect(cases.map((x: unknown) => caseSchema.parse(x).id)).toHaveLength(27);
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
    expect(grade(c("bug"), { reply: "Which page were you on?", handedOff: false }).pass).toBe(true);
    expect(grade(c("bug"), { reply: "Thanks, the team will look.", handedOff: false }).pass).toBe(false);
    const idea = c("idea", { mentions: ["voice"] });
    expect(grade(idea, { reply: "So: send clues as Voice recordings. Thanks!", handedOff: false }).pass).toBe(true);
    expect(grade(idea, { reply: "Thanks!", handedOff: false }).pass).toBe(false);
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
});
