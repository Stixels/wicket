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
import { setupGuild } from "./discord/setup.js";
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

// No key means no assistant: every conversation goes straight to the team.
// The Vercel AI Gateway speaks the Anthropic Messages API, so only the URL, key and model id change.
const gateway = Boolean(config.AI_GATEWAY_API_KEY);
const model = gateway ? gatewayModelId(config.AGENT_MODEL) : config.AGENT_MODEL;
const anthropic = gateway
  ? new Anthropic({ apiKey: config.AI_GATEWAY_API_KEY, baseURL: config.AI_GATEWAY_URL })
  : config.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
    : null;
const agent = anthropic
  ? new Agent(anthropic as any, {
      model,
      effort: config.AGENT_EFFORT,
      maxSteps: config.AGENT_MAX_STEPS,
      productName: config.PRODUCT_NAME,
      productDescription: config.PRODUCT_DESCRIPTION,
      // Haiku has no server-side fallback, and the gateway does not offer it.
      serverFallback: !gateway && !model.includes("haiku"),
    })
  : null;

// With a server id, make sure the community and inbox channels exist and use their ids,
// unless ids were set explicitly.
if (config.RELAY === "discord" && config.DISCORD_GUILD_ID) {
  const setup = await setupGuild(config.DISCORD_BOT_TOKEN!, config.DISCORD_GUILD_ID, config.DISCORD_TEAM_ROLE);
  console.log(`discord: server ready${setup.created.length ? `, created ${setup.created.join(", ")}` : ""}`);
  config.DISCORD_CHANNEL_ID ||= setup.supportInboxId;
  config.DISCORD_COMMUNITY_HELP_CHANNEL_ID ||= setup.helpId;
  config.DISCORD_HANDOFF_MENTION ||= `<@&${setup.teamRoleId}>`;
}

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
  playground: config.PLAYGROUND ? { title: `${config.PRODUCT_NAME} Support` } : undefined,
});
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`wicket listening on http://localhost:${info.port} (agent: ${agent ? `${model}${gateway ? " via AI Gateway" : ""}` : "off"})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    server.close();
    await relay?.stop();
    db.$client.close();
    process.exit(0);
  });
}

/** "claude-sonnet-5-5" -> "anthropic/claude-sonnet-5.5", the gateway's naming. Full gateway ids pass through. */
function gatewayModelId(id: string): string {
  return id.includes("/") ? id : `anthropic/${id.replace(/-(\d+)-(\d+)$/, "-$1.$2")}`;
}
