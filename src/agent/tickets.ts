import type Anthropic from "@anthropic-ai/sdk";
import type { TicketDraft } from "../adapters/types.js";

const TOOL: Anthropic.Tool = {
  name: "create_ticket",
  description: "File one ticket for the engineering team.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short and specific, in the reporter's terms. Under 80 characters, no trailing period." },
      kind: { type: "string", enum: ["bug", "feature", "improvement", "docs", "question"] },
      description: {
        type: "string",
        description:
          "Markdown. Start with a one or two sentence summary. For bugs add '## Steps to reproduce', '## Expected' and '## Actual' when the conversation has them. " +
          "Add '## Context' with page, app version, room or venue if mentioned. Add '## Reported by' with who raised it. " +
          "Only include facts from the conversation; never invent steps.",
      },
    },
    required: ["title", "kind", "description"],
  },
};

/** Turns a Discord conversation and the teammate's ask into a ticket draft. */
export async function draftTicket(
  client: Anthropic,
  model: string,
  productName: string,
  transcript: string,
  ask: string,
): Promise<TicketDraft> {
  const res = await client.messages.create({
    model,
    max_tokens: 2000,
    system:
      `You file tickets for the ${productName} team from Discord conversations. A teammate tagged you in a conversation and asked for a ticket. ` +
      `Follow their instruction (it may name the kind, the title, or which part of the conversation matters). Write for an engineer who wasn't in the conversation.`,
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [
      {
        role: "user",
        content: `<conversation>\n${transcript}\n</conversation>\n\n<teammate_instruction>\n${ask || "File a ticket for this."}\n</teammate_instruction>`,
      },
    ],
  });
  const call = res.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!call) throw new Error("no ticket drafted");
  const input = call.input as TicketDraft;
  return { title: String(input.title).slice(0, 200), description: String(input.description), kind: input.kind };
}
