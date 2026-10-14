import { z } from "zod";

export const caseSchema = z
  .object({
    id: z.number(),
    kind: z.enum(["answer", "handoff", "decline", "bug", "idea", "code", "hardware"]),
    question: z.string(),
    /** Fragments of a link the reply should contain, any one of them. */
    links: z.array(z.string()).default([]),
    /** Words the reply should contain, any one of them. */
    mentions: z.array(z.string()).default([]),
  })
  .strict();
export type EvalCase = z.infer<typeof caseSchema>;

export interface Outcome {
  reply: string;
  handedOff: boolean;
}

export interface Grade {
  pass: boolean;
  /** What failed, empty when it passed. */
  why: string[];
}

/** A short reply: a decline should be a sentence or two, not an essay. */
const SHORT_CHARS = 400;
const CANT_CODE = /\b(not set up to|can(?:'|’)?t|cannot|won(?:'|’)?t|don(?:'|’)?t|unable to)\b[^.]*\b(write|writing|build|create|provide)\b[^.]*\b(code|sketch|sketches|programs?|firmware)\b/i;
// The app attaches the page, app version and recent errors, so a bug follow-up shouldn't ask for them.
const ASKS_APP_CONTEXT = /\b(which|what) (page|screen|version|browser)\b|\bapp version\b|\b(error|console) (message|log)s? (do|did) you see\b/i;
// An idea is taken here, never redirected to another channel.
const SENDS_ELSEWHERE = /\b(feedback (channel|form|portal)|send it (through|to)|reach out to|contact (the )?(team|support)|don't have a way to (log|record|file))\b/i;
const MANAGED_BOARDS = /\b(UNO R4|GIGA)\b/i;
const OTHER_DEVICES = /\b(MQTT|HTTP|other boards?|board adapter|any (?:device|board))\b/i;

/** Scores one reply by its case's kind. No model is involved, so a run is cheap and repeatable. */
export function grade(c: EvalCase, o: Outcome): Grade {
  const why: string[] = [];
  const check = (ok: boolean, failure: string) => void (ok || why.push(failure));
  const links = linksIn(o.reply);
  const linksOne = (fragments: string[]) => links.some((l) => fragments.some((f) => l.toLowerCase().includes(f.toLowerCase())));
  const hasCode = /```/.test(o.reply);
  const noHandoff = () => check(!o.handedOff, "handed off");

  switch (c.kind) {
    case "answer":
      noHandoff();
      check(linksOne(c.links), `no link to ${c.links.join(" or ")}`);
      break;
    case "handoff":
      check(o.handedOff, "didn't hand off");
      break;
    case "decline":
      noHandoff();
      check(!hasCode, "wrote code");
      check(o.reply.length <= SHORT_CHARS, `reply is ${o.reply.length} characters`);
      break;
    case "bug":
      noHandoff();
      check(o.reply.includes("?"), "asked no question");
      check(!ASKS_APP_CONTEXT.test(o.reply), "asked for something the app already sends");
      break;
    case "idea":
      noHandoff();
      check(c.mentions.some((m) => o.reply.toLowerCase().includes(m.toLowerCase())), "didn't restate the idea");
      check(!SENDS_ELSEWHERE.test(o.reply), "sent the user elsewhere instead of taking the idea");
      break;
    case "code":
      noHandoff();
      check(!hasCode, "wrote code");
      check(CANT_CODE.test(o.reply), "didn't say it can't write code");
      check(linksOne(c.links), `no link to ${c.links.join(" or ")}`);
      break;
    case "hardware":
      check(MANAGED_BOARDS.test(o.reply), "didn't name the bundled boards");
      check(OTHER_DEVICES.test(o.reply), "didn't say other boards or MQTT/HTTP devices work");
      check(linksOne(c.links), `no link to ${c.links.join(" or ")}`);
      break;
  }
  return { pass: why.length === 0, why };
}

/** Markdown link targets and bare URLs in a reply. */
export function linksIn(text: string): string[] {
  const md = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  const bare = [...text.matchAll(/(?<!\()https?:\/\/[^\s)\]>]+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
  return [...new Set([...md, ...bare])];
}
