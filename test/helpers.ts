import { MockLanguageModelV4 } from "ai/test";
import { ThreadGoneError, type Relay, type RelayConversation, type RelayFile, type RelayMember, type StaffReply } from "../src/adapters/types.js";
import type { ModelProvider } from "../src/agent/agent.js";

/** A scripted model reply, written as the Anthropic API would send it. */
export interface Scripted {
  content: any[];
  stop_reason: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

/** What a test reads back from one model call: the model id, system prompt, messages, tools and provider options. */
export interface Request {
  model: string;
  system: string;
  messages: any[];
  tools: any[];
  providerOptions: Record<string, any>;
  raw: any;
}

const FINISH: Record<string, "stop" | "tool-calls" | "content-filter" | "length"> = {
  end_turn: "stop",
  tool_use: "tool-calls",
  refusal: "content-filter",
  max_tokens: "length",
};

/** Scripted stand-in for the model provider: returns queued responses and records requests. */
export class FakeClient implements ModelProvider {
  requests: Request[] = [];
  constructor(private responses: Scripted[]) {}
  languageModel(id: string) {
    return new MockLanguageModelV4({
      modelId: id,
      doGenerate: async (options) => {
        const prompt = structuredClone(options.prompt) as any[];
        this.requests.push({
          model: id,
          system: prompt.filter((m) => m.role === "system").map((m) => m.content).join("\n"),
          messages: prompt.filter((m) => m.role !== "system"),
          tools: options.tools ?? [],
          providerOptions: options.providerOptions ?? {},
          raw: options,
        });
        const next = this.responses.shift();
        if (!next) throw new Error("FakeClient: no more scripted responses");
        const u = next.usage ?? {};
        const [input, cacheRead, cacheWrite] = [u.input_tokens ?? 0, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0];
        return {
          content: next.content.map((b) =>
            b.type === "thinking"
              ? { type: "reasoning" as const, text: b.thinking, providerMetadata: { anthropic: { signature: b.signature } } }
              : b.type === "tool_use"
                ? { type: "tool-call" as const, toolCallId: b.id, toolName: b.name, input: JSON.stringify(b.input) }
                : { type: "text" as const, text: b.text },
          ),
          finishReason: { unified: FINISH[next.stop_reason] ?? "other", raw: next.stop_reason },
          usage: {
            inputTokens: { total: input + cacheRead + cacheWrite, noCache: input, cacheRead, cacheWrite },
            outputTokens: { total: u.output_tokens ?? 0, text: undefined, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
  }
}

export const text = (t: string): Scripted => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
export const toolCall = (name: string, input: object, id = `tu_${name}`): Scripted => ({
  content: [
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "tool_use", id, name, input },
  ],
  stop_reason: "tool_use",
});

export class FakeRelay implements Relay {
  name = "fake";
  threads = new Map<string, { conversation: RelayConversation; posts: string[] }>();
  humanRequests: string[] = [];
  private opened = 0;
  events: string[] = [];
  private onReply?: (r: StaffReply) => Promise<void>;
  private onResolved?: (threadId: string, deleted?: boolean) => Promise<boolean>;
  async start(onStaffReply: (r: StaffReply) => Promise<void>, onResolved?: (threadId: string, deleted?: boolean) => Promise<boolean>) {
    this.onReply = onStaffReply;
    this.onResolved = onResolved;
  }
  async markResolved(threadId: string) {
    this.events.push(`resolved ${threadId}`);
  }
  async reopen(threadId: string) {
    this.events.push(`reopened ${threadId}`);
  }
  /** Simulates the team closing the post. */
  close(threadId: string) {
    return this.onResolved!(threadId);
  }
  /** Simulates the team deleting the post. */
  delete(threadId: string) {
    return this.onResolved!(threadId, true);
  }
  async openThread(conversation: RelayConversation, firstMessage: string) {
    const id = `thread_${++this.opened}`;
    this.threads.set(id, { conversation, posts: [`user: ${firstMessage}`] });
    return id;
  }
  async post(threadId: string, author: string, body: string, _name?: string | null, files: RelayFile[] = []) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new ThreadGoneError(threadId);
    thread.posts.push(`${author}: ${body}${files.map((f) => ` [file ${f.name} ${f.data.length}B]`).join("")}`);
  }
  /** Set to make deleteThread fail, like Discord being down. */
  failDeletes = false;
  async deleteThread(threadId: string) {
    if (this.failDeletes) throw new Error("Discord is down");
    if (!this.threads.delete(threadId)) throw new ThreadGoneError(threadId);
    this.events.push(`deleted ${threadId}`);
  }
  /** Deletes the thread without telling the service, like a missed Discord event. */
  vanish(threadId: string) {
    this.threads.delete(threadId);
  }
  async postNote(threadId: string, author: RelayMember, body: string, mentions: RelayMember[]) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new ThreadGoneError(threadId);
    thread.posts.push(`note ${author.name}: ${body}${mentions.map((m) => ` [ping ${m.relayId ?? m.name}]`).join("")}`);
  }
  async requestHuman(threadId: string, reason: string) {
    this.humanRequests.push(`${threadId}: ${reason}`);
  }
  async stop() {}
  staffReply(threadId: string, body: string, files?: RelayFile[], extra: Partial<StaffReply> = {}) {
    return this.onReply!({ threadId, authorName: "Matt", body, files, ...extra });
  }
}
