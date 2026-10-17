import type { AssistantContent, ContentPart, JSONValue, ModelMessage, ToolSet, UserContent } from "ai";

type AssistantPart = Exclude<AssistantContent, string>[number];
type UserPart = Exclude<UserContent, string>[number];

/**
 * Stored transcripts keep the Anthropic Messages block shape they were first written in, so
 * conversations from before the AI SDK replay unchanged. These convert to and from the SDK's
 * messages at call time.
 */
export type Block =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: string; data: string }; title?: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: string | { type: "text"; text: string }[]; is_error?: boolean }
  // Anthropic's server-side fallback answered instead of the requested model.
  | { type: "fallback"; from: { model: string }; to: { model: string } };

export interface Turn {
  role: "user" | "assistant";
  content: string | Block[];
}

type ProviderOptions = Record<string, Record<string, JSONValue>>;
const EPHEMERAL: ProviderOptions = { anthropic: { cacheControl: { type: "ephemeral" } } };

export const blocksOf = (content: Turn["content"]): Block[] => (typeof content === "string" ? [{ type: "text", text: content }] : content);

/**
 * Stored turns as AI SDK messages. A user turn's tool results become a tool message ahead of
 * the rest of the turn. With `cacheLast`, the newest part carries Anthropic's cache breakpoint,
 * so the next call reads the conversation so far from the cache.
 */
export function toModelMessages(turns: Turn[], { cacheLast = false } = {}): ModelMessage[] {
  const toolNames = new Map<string, string>();
  const out: ModelMessage[] = [];
  for (const turn of turns) {
    const blocks = blocksOf(turn.content);
    if (turn.role === "assistant") {
      const content = blocks.flatMap((b) => assistantPart(b, toolNames));
      if (content.length) out.push({ role: "assistant", content });
      continue;
    }
    const results = blocks.filter((b) => b.type === "tool_result");
    if (results.length) {
      out.push({
        role: "tool",
        content: results.map((r) => ({
          type: "tool-result",
          toolCallId: r.tool_use_id,
          toolName: toolNames.get(r.tool_use_id) ?? "unknown",
          output: { type: r.is_error ? "error-text" : "text", value: resultText(r.content) },
        })),
      });
    }
    const content = blocks.flatMap(userPart);
    if (content.length) out.push({ role: "user", content });
  }
  if (cacheLast) markLast(out);
  return out;
}

function assistantPart(b: Block, toolNames: Map<string, string>): AssistantPart[] {
  switch (b.type) {
    case "text":
      return [{ type: "text", text: b.text }];
    case "thinking":
      return [{ type: "reasoning", text: b.thinking, providerOptions: { anthropic: { signature: b.signature } } }];
    case "redacted_thinking":
      return [{ type: "reasoning", text: "", providerOptions: { anthropic: { redactedData: b.data } } }];
    case "tool_use":
      toolNames.set(b.id, b.name);
      return [{ type: "tool-call", toolCallId: b.id, toolName: b.name, input: b.input }];
    case "fallback":
      return [{ type: "custom", kind: "anthropic.fallback", providerOptions: { anthropic: { type: "fallback", from: b.from, to: b.to } } }];
    default:
      return [];
  }
}

function userPart(b: Block): UserPart[] {
  switch (b.type) {
    case "text":
      return [{ type: "text", text: b.text }];
    case "image":
    case "document":
      return [{ type: "file", mediaType: b.source.media_type, data: { type: "data", data: b.source.data } }];
    default:
      return [];
  }
}

function resultText(content: Extract<Block, { type: "tool_result" }>["content"]): string {
  if (content === undefined) return "";
  return typeof content === "string" ? content : content.map((c) => c.text).join("\n");
}

/** Reasoning can't carry a cache breakpoint, so a message ending on one is left unmarked. */
function markLast(messages: ModelMessage[]) {
  const last = messages.at(-1);
  if (!last || typeof last.content === "string" || last.role === "system") return;
  const end = last.content.at(-1);
  if (!end || end.type === "reasoning" || end.type === "tool-approval-request" || end.type === "tool-approval-response") return;
  end.providerOptions = { ...end.providerOptions, ...EPHEMERAL };
}

/** The system prompt as a cached system message. */
export function cachedInstructions(text: string) {
  return { role: "system" as const, content: text, providerOptions: EPHEMERAL };
}

/**
 * One model response as a stored assistant turn. Reasoning is kept only where it can be replayed
 * (Anthropic's signed thinking); other providers' reasoning is dropped, as their APIs allow.
 */
export function fromStep(content: ContentPart<ToolSet>[]): Turn {
  const blocks: Block[] = [];
  for (const part of content) {
    const anthropic = ("providerMetadata" in part ? part.providerMetadata?.anthropic : undefined) as Record<string, unknown> | undefined;
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "reasoning") {
      if (typeof anthropic?.signature === "string") blocks.push({ type: "thinking", thinking: part.text, signature: anthropic.signature });
      else if (typeof anthropic?.redactedData === "string") blocks.push({ type: "redacted_thinking", data: anthropic.redactedData });
    } else if (part.type === "tool-call" && !part.providerExecuted) {
      const input = part.input && typeof part.input === "object" ? part.input : {};
      blocks.push({ type: "tool_use", id: part.toolCallId, name: part.toolName, input });
    } else if (part.type === "custom" && part.kind === "anthropic.fallback" && anthropic?.from && anthropic.to) {
      blocks.push({ type: "fallback", from: anthropic.from as { model: string }, to: anthropic.to as { model: string } });
    }
  }
  return { role: "assistant", content: blocks };
}

export function textOf(content: Turn["content"]): string {
  return blocksOf(content)
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
