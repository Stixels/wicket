import Anthropic from "@anthropic-ai/sdk";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { Agent, answerOnce } from "./agent/agent.js";
import { ConversationService } from "./conversations.js";
import { createServer } from "./server.js";
import { reindex, searchDocs } from "./knowledge/index.js";
import { MarkdownRepoSource } from "./adapters/knowledge/markdownRepo.js";
import { DiscordRelay } from "./adapters/relay/discord.js";
import type { KnowledgeSource, Relay } from "./adapters/types.js";

const config = loadConfig();
const db = openDb(config.DATABASE_PATH);

const sources: KnowledgeSource[] = [];
if (config.DOCS_GITHUB_REPO) {
  sources.push(
    new MarkdownRepoSource({
      repo: config.DOCS_GITHUB_REPO,
      ref: config.DOCS_GITHUB_REF,
      token: config.DOCS_GITHUB_TOKEN,
      baseUrl: config.DOCS_BASE_URL,
    }),
  );
}

// No API key means no assistant: every conversation goes straight to the team.
const agent = process.env.ANTHROPIC_API_KEY
  ? new Agent(new Anthropic() as any, {
      model: config.AGENT_MODEL,
      effort: config.AGENT_EFFORT,
      maxSteps: config.AGENT_MAX_STEPS,
      productName: config.PRODUCT_NAME,
      productDescription: config.PRODUCT_DESCRIPTION,
    })
  : null;

let relay: Relay | null = null;
if (config.RELAY === "discord") {
  relay = new DiscordRelay({
    token: config.DISCORD_BOT_TOKEN!,
    channelId: config.DISCORD_CHANNEL_ID!,
    handoffMention: config.DISCORD_HANDOFF_MENTION,
    communityHelpChannelId: config.DISCORD_COMMUNITY_HELP_CHANNEL_ID,
    answerCommunityPost: agent ? (q) => answerOnce(agent, q, (query) => searchDocs(db, query)) : undefined,
  });
}

const service = new ConversationService(db, agent, relay, (msg, err) => console.error(msg, err ?? ""));

async function refreshDocs() {
  if (!sources.length) return;
  try {
    const n = await reindex(db, sources);
    console.log(`docs: indexed ${n} sections`);
  } catch (err) {
    console.error("docs: reindex failed, keeping the previous index", err);
  }
}

await refreshDocs();
setInterval(refreshDocs, config.DOCS_REINDEX_HOURS * 3_600_000).unref();

if (relay) {
  await relay.start(({ threadId, authorName, body }) => service.handleStaffReply(threadId, authorName, body));
  console.log(`relay: ${relay.name} connected`);
}

const app = createServer(service, {
  allowedOrigins: config.ALLOWED_ORIGINS,
  maxMessagesPerConversationPerHour: config.MAX_MESSAGES_PER_CONVERSATION_PER_HOUR,
  maxConversationsPerIpPerHour: config.MAX_CONVERSATIONS_PER_IP_PER_HOUR,
});
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`wicket listening on :${info.port} (agent: ${agent ? config.AGENT_MODEL : "off"})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    server.close();
    await relay?.stop();
    db.$client.close();
    process.exit(0);
  });
}
