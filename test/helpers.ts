import type { Relay, RelayConversation, StaffReply } from "../src/adapters/types.js";
import type { MessagesClient } from "../src/agent/agent.js";

/** Scripted stand-in for the Anthropic client: returns queued responses and records requests. */
export class FakeClient implements MessagesClient {
  requests: any[] = [];
  constructor(private responses: Array<{ content: any[]; stop_reason: string }>) {}
  beta = {
    messages: {
      create: async (params: any) => {
        this.requests.push(structuredClone(params));
        const next = this.responses.shift();
        if (!next) throw new Error("FakeClient: no more scripted responses");
        return next;
      },
    },
  };
}

export const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
export const toolCall = (name: string, input: object, id = `tu_${name}`) => ({
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
  private onReply?: (r: StaffReply) => Promise<void>;
  async start(onStaffReply: (r: StaffReply) => Promise<void>) {
    this.onReply = onStaffReply;
  }
  async openThread(conversation: RelayConversation, firstMessage: string) {
    const id = `thread_${this.threads.size + 1}`;
    this.threads.set(id, { conversation, posts: [`user: ${firstMessage}`] });
    return id;
  }
  async post(threadId: string, author: string, body: string) {
    this.threads.get(threadId)!.posts.push(`${author}: ${body}`);
  }
  async requestHuman(threadId: string, reason: string) {
    this.humanRequests.push(`${threadId}: ${reason}`);
  }
  async stop() {}
  staffReply(threadId: string, body: string) {
    return this.onReply!({ threadId, authorName: "Matt", body });
  }
}
