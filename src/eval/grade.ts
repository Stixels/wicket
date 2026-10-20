import { z } from "zod";
import type { TrackerLog } from "./tracker.js";

export const caseSchema = z
  .object({
    id: z.number(),
    kind: z.enum(["answer", "handoff", "decline", "bug", "idea", "code", "hardware", "route"]),
    question: z.string(),
    /** What the person says next, one message per entry, each after the assistant's reply. */
    then: z.array(z.string()).default([]),
    /** Fragments of a link the reply should contain, any one of them. */
    links: z.array(z.string()).default([]),
    /** Words the reply should contain, any one of them. For route: file, words the new ticket should contain. */
    mentions: z.array(z.string()).default([]),
    /** route: what should happen in the tracker. */
    route: z.enum(["file", "add", "none"]).optional(),
    /** route add: the backlog ticket the report belongs on. */
    key: z.string().optional(),
    /** route file: the kinds the new ticket may have, any one of them. */
    ticketKinds: z.array(z.enum(["bug", "feature", "improvement", "docs"])).default([]),
  })
  .strict()
  .refine((c) => c.kind !== "route" || c.route, { message: "a route case needs `route`" })
  .refine((c) => c.route !== "add" || c.key, { message: "a route: add case needs `key`" });
export type EvalCase = z.infer<typeof caseSchema>;

export interface Outcome {
  reply: string;
  handedOff: boolean;
  /** What the assistant filed and added to, when the case ran with a tracker. */
  tickets?: TrackerLog;
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
// Ticket keys and the tracker stay out of what the person reads.
const TICKET_KEY = /\b[A-Z]{2,}-\d+\b/;
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
    case "route": {
      const { filed, added } = o.tickets ?? { filed: [], added: [] };
      const did = [...filed.map((f) => `filed ${f.kind} "${f.title}"`), ...added.map((k) => `added to ${k}`)].join(", ") || "logged nothing";
      if (c.route === "none") check(!filed.length && !added.length, `should log nothing, but ${did}`);
      if (c.route === "add") check(!filed.length && added.length === 1 && added[0] === c.key, `should add to ${c.key}, but ${did}`);
      if (c.route === "file") {
        check(filed.length === 1 && !added.length, `should file one new ticket, but ${did}`);
        const f = filed[0];
        if (f && filed.length === 1 && c.ticketKinds.length) check(c.ticketKinds.includes(f.kind as never), `filed as ${f.kind}, expected ${c.ticketKinds.join(" or ")}`);
        const body = f ? `${f.title}\n${f.description}`.toLowerCase() : "";
        if (f && c.mentions.length) check(c.mentions.some((m) => body.includes(m.toLowerCase())), `ticket doesn't mention ${c.mentions.join(" or ")}`);
      }
      check(!TICKET_KEY.test(o.reply), "told the user a ticket key");
      break;
    }
  }
  return { pass: why.length === 0, why };
}

/** Markdown link targets and bare URLs in a reply. */
export function linksIn(text: string): string[] {
  const md = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  const bare = [...text.matchAll(/(?<!\()https?:\/\/[^\s)\]>]+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
  return [...new Set([...md, ...bare])];
}

/** An open ticket the fake tracker starts with, for route cases to find. */
export const backlogSchema = z
  .object({
    key: z.string(),
    title: z.string(),
    kind: z.enum(["bug", "feature", "improvement", "docs"]),
    description: z.string().optional(),
  })
  .strict();
