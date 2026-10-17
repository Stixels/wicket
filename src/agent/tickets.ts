import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import type { TicketDraft } from "../adapters/types.js";

const TICKET = z.object({
  title: z.string().describe("Short and specific, in the reporter's terms. Under 80 characters, no trailing period."),
  kind: z.enum(["bug", "feature", "improvement", "docs", "question"]),
  description: z
    .string()
    .describe(
      "Markdown. Start with a one or two sentence summary. For bugs add '## Steps to reproduce', '## Expected' and '## Actual' when the conversation has them. " +
        "Add '## Context' with page, app version, room or venue if mentioned. Add '## Reported by' with who raised it. " +
        "Only include facts from the conversation; never invent steps.",
    ),
});

/** Turns a Discord conversation and the teammate's ask into a ticket draft. */
export async function draftTicket(model: LanguageModel, productName: string, transcript: string, ask: string): Promise<TicketDraft> {
  const { output } = await generateText({
    model,
    maxOutputTokens: 2000,
    instructions:
      `You file tickets for the ${productName} team from Discord conversations. A teammate tagged you in a conversation and asked for a ticket. ` +
      `Follow their instruction (it may name the kind, the title, or which part of the conversation matters). Write for an engineer who wasn't in the conversation.`,
    output: Output.object({ schema: TICKET, name: "ticket", description: "One ticket for the engineering team." }),
    prompt: `<conversation>\n${transcript}\n</conversation>\n\n<teammate_instruction>\n${ask || "File a ticket for this."}\n</teammate_instruction>`,
  });
  return { title: output.title.slice(0, 200), description: output.description, kind: output.kind };
}
