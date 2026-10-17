import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent/agent.js";
import { fromStep, toModelMessages, type Turn } from "../src/agent/transcript.js";
import { gatewayModelId } from "../src/gateway.js";
import { loadSettings, resolveProfile } from "../src/settings.js";
import { FakeClient, text } from "./helpers.js";

const tools = { searchDocs: () => [], readDoc: () => null, handoff: async () => {} };
const opts = { model: "anthropic/claude-haiku-5.5", effort: "low" as const, maxSteps: 4, productName: "Escape Director", productDescription: "", modelId: gatewayModelId };
const ask: Turn[] = [{ role: "user", content: [{ type: "text", text: "Which Puzzle takes longest?" }] }];

describe("stored transcripts", () => {
  const stored: Turn[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Why does this fail?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0K" } },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Check the docs.", signature: "sig" },
        { type: "text", text: "Let me look." },
        { type: "tool_use", id: "tu_1", name: "search_docs", input: { query: "start puzzle" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "No matching documentation.", is_error: true },
        { type: "text", text: "Any luck?" },
      ],
    },
  ];

  it("become AI SDK messages, with tool results named and ahead of the user's text", () => {
    expect(toModelMessages(stored)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Why does this fail?" },
          { type: "file", mediaType: "image/png", data: { type: "data", data: "iVBORw0K" } },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Check the docs.", providerOptions: { anthropic: { signature: "sig" } } },
          { type: "text", text: "Let me look." },
          { type: "tool-call", toolCallId: "tu_1", toolName: "search_docs", input: { query: "start puzzle" } },
        ],
      },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "tu_1", toolName: "search_docs", output: { type: "error-text", value: "No matching documentation." } }] },
      { role: "user", content: [{ type: "text", text: "Any luck?" }] },
    ]);
  });

  it("come back from a model response in the stored shape", () => {
    const step = fromStep([
      { type: "reasoning", text: "Check the docs.", providerMetadata: { anthropic: { signature: "sig" } } },
      { type: "reasoning", text: "unsigned reasoning from another provider", providerMetadata: { openai: { itemId: "rs_1" } } },
      { type: "text", text: "Let me look." },
      { type: "tool-call", toolCallId: "tu_1", toolName: "search_docs", input: { query: "start puzzle" } },
    ]);
    expect(step).toEqual(stored[1]);
  });
});

describe("provider options", () => {
  it("sends the analytics profile's OpenAI options and effort with an openai model", async () => {
    const profile = resolveProfile(loadSettings(undefined, "config/wicket.yaml"), { signedIn: true, plan: null, path: "/app/analytics" });
    expect(profile.name).toBe("analytics");
    const client = new FakeClient([text("Cabin 13's lock puzzle takes longest.")]);
    await new Agent(client, opts).respond(ask, tools, { model: profile.model, effort: profile.effort, providerOptions: profile.providerOptions });

    expect(client.requests[0]!.model).toBe("openai/gpt-6-luna");
    expect(client.requests[0]!.providerOptions).toEqual({ gateway: { only: ["openai"] }, openai: { store: false, reasoningEffort: "medium" } });
  });

  it("sends Anthropic models their effort, and the server-side fallback when it's on", async () => {
    const client = new FakeClient([text("Hi.")]);
    await new Agent(client, { ...opts, model: "claude-opus-5-5", modelId: undefined, serverFallback: true }).respond(ask, tools, { effort: "high" });
    expect(client.requests[0]!.model).toBe("claude-opus-5-5");
    expect(client.requests[0]!.providerOptions).toEqual({ anthropic: { effort: "high", fallbacks: "default" } });
  });
});
