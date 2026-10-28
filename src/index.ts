import { createAnthropic } from "@ai-sdk/anthropic";
import { createGateway } from "@ai-sdk/gateway";
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { openDb } from "./db/index.js";
import { Agent, answerOnce } from "./agent/agent.js";
import { ConversationService } from "./conversations.js";
import { createServer } from "./server.js";
import { reindex, readDoc, searchDocs } from "./knowledge/index.js";
import { knowledgeSources } from "./knowledge/sources.js";
import { DiscordRelay } from "./adapters/relay/discord.js";
import { setupGuild } from "./discord/setup.js";
import { GitHubIssuesTracker } from "./adapters/tracker/github.js";
import { LinearTracker } from "./adapters/tracker/linear.js";
import { draftTicket } from "./agent/tickets.js";
import { COMMUNITY_ROOM_PREFIX, SUPPORT_ROOM_PREFIX } from "./discord/voiceRooms.js";
import type { Relay } from "./adapters/types.js";
import { loadSettings } from "./settings.js";
import { FileStore } from "./files.js";
import { ReplyEmails, ResendMailer } from "./email.js";
import { priceFor } from "./usage.js";
import { gatewayModelId } from "./gateway.js";
import { TicketDesk } from "./tickets.js";
import { Announcer } from "./announcements.js";
import { REST, Routes } from "discord.js";

const config = loadConfig();
const settings = loadSettings(config.WICKET_CONFIG);
const db = openDb(config.DATABASE_PATH);

const sources = knowledgeSources(config, settings);

// No key means no assistant: every conversation goes straight to the team.
// Through the Vercel AI Gateway any provider's model works ("openai/..."), with its own provider options.
const gateway = Boolean(config.AI_GATEWAY_API_KEY);
const model = gateway ? gatewayModelId(config.AGENT_MODEL) : config.AGENT_MODEL;
const models = gateway
  ? createGateway({ apiKey: config.AI_GATEWAY_API_KEY, ...(config.AI_GATEWAY_URL ? { baseURL: config.AI_GATEWAY_URL } : {}) })
  : config.ANTHROPIC_API_KEY
    ? createAnthropic({ apiKey: config.ANTHROPIC_API_KEY })
    : null;
const agent = models
  ? new Agent(models, {
      model,
      effort: config.AGENT_EFFORT,
      maxSteps: config.AGENT_MAX_STEPS,
      productName: config.PRODUCT_NAME,
      productDescription: config.PRODUCT_DESCRIPTION,
      // Haiku has no server-side fallback, and the gateway does not offer it.
      serverFallback: !gateway && !model.includes("haiku"),
      modelId: gateway ? gatewayModelId : undefined,
      instructions: settings.assistant.instructions,
      code: settings.assistant.code,
    })
  : null;

// With a server id, make sure the community and inbox channels exist and use their ids,
// unless ids were set explicitly.
if (config.RELAY === "discord" && config.DISCORD_GUILD_ID) {
  const setup = await setupGuild(config.DISCORD_BOT_TOKEN!, config.DISCORD_GUILD_ID, {
    teamRoleName: config.DISCORD_TEAM_ROLE,
    productName: config.PRODUCT_NAME,
    docsUrl: config.DOCS_BASE_URL,
    assistantAnswersHelp: settings.assistant.helpForum,
  });
  console.log(`discord: server ready${setup.created.length ? `: ${setup.created.join(", ")}` : ""}`);
  for (const step of setup.manual) console.log(`discord: needs you: ${step}`);
  config.DISCORD_CHANNEL_ID ||= setup.supportInboxId;
  config.DISCORD_COMMUNITY_HELP_CHANNEL_ID ||= setup.helpId;
  config.DISCORD_HANDOFF_MENTION ||= `<@&${setup.teamRoleId}>`;
  config.DISCORD_VOICE_HUB_CHANNEL_ID ||= setup.voiceHubId;
  config.DISCORD_SUPPORT_VOICE_HUB_CHANNEL_ID ||= setup.supportVoiceHubId;
  config.DISCORD_TEAM_ROLE_ID ||= setup.teamRoleId;
  config.DISCORD_ANNOUNCEMENTS_CHANNEL_ID ||= setup.announcementsId;
}

const tracker = config.LINEAR_API_KEY
  ? new LinearTracker({ apiKey: config.LINEAR_API_KEY, teamKey: config.LINEAR_TEAM_KEY!, sourceLabel: config.LINEAR_SOURCE_LABEL })
  : config.GITHUB_ISSUES_REPO
    ? new GitHubIssuesTracker({ token: config.GITHUB_ISSUES_TOKEN!, repo: config.GITHUB_ISSUES_REPO, sourceLabel: config.GITHUB_ISSUES_LABEL })
    : null;
if (tracker) {
  await tracker.check().then(
    (where) => console.log(`${tracker.name}: ready (${where})`),
    (err) => console.error(`${tracker.name}: ${err.message}`),
  );
}

// Remembers which conversations each ticket came from, and tells them when it's done.
const desk = tracker ? new TicketDesk(db, tracker, { notify: (n) => service.ticketNews(n), log: (msg, err) => console.error(msg, err ?? "") }) : null;

let relay: Relay | null = null;
if (config.RELAY === "discord") {
  relay = new DiscordRelay({
    token: config.DISCORD_BOT_TOKEN!,
    channelId: config.DISCORD_CHANNEL_ID!,
    handoffMention: config.DISCORD_HANDOFF_MENTION,
    communityHelpChannelId: config.DISCORD_COMMUNITY_HELP_CHANNEL_ID,
    voiceHubs: [
      ...(config.DISCORD_VOICE_HUB_CHANNEL_ID
        ? [{ channelId: config.DISCORD_VOICE_HUB_CHANNEL_ID, prefix: COMMUNITY_ROOM_PREFIX }]
        : []),
      ...(config.DISCORD_SUPPORT_VOICE_HUB_CHANNEL_ID && config.DISCORD_TEAM_ROLE_ID
        ? [{ channelId: config.DISCORD_SUPPORT_VOICE_HUB_CHANNEL_ID, prefix: SUPPORT_ROOM_PREFIX, teamRoleId: config.DISCORD_TEAM_ROLE_ID }]
        : []),
    ],
    answerCommunityPost: agent && settings.assistant.helpForum ? (q) => answerOnce(agent, q, { searchDocs: (query) => searchDocs(db, query), readDoc: (url) => readDoc(db, url) }) : undefined,
    tickets:
      models && desk
        ? {
            desk,
            draft: (transcript, ask) => draftTicket(models.languageModel(model), config.PRODUCT_NAME, transcript, ask),
            teamRoleId: config.DISCORD_TEAM_ROLE_ID,
            conversationFor: (threadId) => service.conversationForThread(threadId),
            conversationUrl: (id) => service.dashboardUrl(id),
          }
        : undefined,
  });
}

const mailer = config.RESEND_API_KEY && config.EMAIL_FROM && config.PUBLIC_URL ? new ResendMailer(config.RESEND_API_KEY, config.EMAIL_FROM) : null;
const service = new ConversationService(db, agent, relay, {
  settings,
  files: new FileStore(db, config.DATABASE_PATH),
  log: (msg, err) => console.error(msg, err ?? ""),
  emailReplies: Boolean(mailer),
  tickets: desk,
  publicUrl: config.PUBLIC_URL,
  appToolSteps: config.AGENT_MAX_STEPS_WITH_APP_TOOLS,
});
const replyEmails = mailer
  ? new ReplyEmails(db, service, mailer, { productName: config.PRODUCT_NAME, publicUrl: config.PUBLIC_URL!, replyDomain: config.EMAIL_REPLY_DOMAIN })
  : null;
if (replyEmails) {
  setInterval(() => void replyEmails.sweep().catch((err) => console.error("email: sweep failed", err)), 60_000).unref();
  console.log(`email: unread team replies are emailed${replyEmails.canReceive ? ", and replies to them come back" : ""}`);
} else if (config.RESEND_API_KEY) {
  console.log("email: needs you: set EMAIL_FROM and PUBLIC_URL as well as RESEND_API_KEY");
}
describeSettings();

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

// Old attachments go after files.keepDays; uploads that were never sent go after a day.
function sweepFiles() {
  try {
    const n = service.files.sweep(settings.files.keepDays);
    if (n) console.log(`files: removed ${n} old or unsent attachments`);
  } catch (err) {
    console.error("files: cleanup failed", err);
  }
}
sweepFiles();
setInterval(sweepFiles, 6 * 3_600_000).unref();
setInterval(refreshDocs, config.DOCS_REINDEX_HOURS * 3_600_000).unref();

// Reporters hear back when their ticket is done.
if (desk?.canFollow && settings.tickets.checkMinutes > 0) {
  const checkTickets = () =>
    void desk.check().then(
      (n) => n && console.log(`tickets: told ${n} ${n === 1 ? "person" : "people"} their report is done`),
      (err) => console.error("tickets: check failed", err),
    );
  checkTickets();
  setInterval(checkTickets, settings.tickets.checkMinutes * 60_000).unref();
  console.log(`tickets: ${settings.tickets.assistant && agent ? "the assistant logs reports, and " : ""}reporters hear back when tickets are done (checked every ${settings.tickets.checkMinutes} min)`);
}

// New posts in a feed (the product's updates) go to #announcements, and to servers that follow it.
if (settings.announcements.feed) {
  const channelId = config.DISCORD_ANNOUNCEMENTS_CHANNEL_ID;
  if (config.RELAY !== "discord" || !channelId) {
    console.log("announcements: needs you: set RELAY=discord with DISCORD_GUILD_ID or DISCORD_ANNOUNCEMENTS_CHANNEL_ID to post the feed");
  } else {
    const rest = new REST({ version: "10" }).setToken(config.DISCORD_BOT_TOKEN!);
    const accent = settings.theme.accentColor?.match(/^#([0-9a-f]{6})$/i)?.[1];
    const announcer = new Announcer(db, {
      feedUrl: settings.announcements.feed,
      color: accent ? parseInt(accent, 16) : undefined,
      log: (msg) => console.log(msg),
      post: async (message) => {
        const sent = (await rest.post(Routes.channelMessages(channelId), { body: message })) as { id: string };
        // Publishing sends it on to servers that follow the channel. Plain text channels can't publish.
        await rest.post(Routes.channelMessageCrosspost(channelId, sent.id)).catch((err) => console.warn(`announcements: posted but couldn't publish: ${err.message}`));
      },
    });
    const checkFeed = () =>
      void announcer.check().then(
        (n) => n && console.log(`announcements: posted ${n} new ${n === 1 ? "update" : "updates"}`),
        (err) => console.error("announcements: check failed", err),
      );
    checkFeed();
    setInterval(checkFeed, settings.announcements.checkMinutes * 60_000).unref();
    console.log(`announcements: posting new items from ${settings.announcements.feed} (checked every ${settings.announcements.checkMinutes} min)`);
  }
}

if (relay) {
  await relay.start(
    ({ threadId, authorName, body, files, ...from }) => service.handleStaffReply(threadId, authorName, body, files, from),
    (threadId, deleted) => service.resolve(threadId, deleted),
    ({ threadId, authorName, authorId }) => service.typingInThread(threadId, authorName, authorId),
  );
  console.log(`relay: ${relay.name} connected${tracker && models ? `, tag the bot to file ${tracker.name === "github" ? "GitHub issues" : "Linear tickets"}` : ""}`);
}

const app = createServer(service, {
  allowedOrigins: config.ALLOWED_ORIGINS,
  maxMessagesPerConversationPerHour: config.MAX_MESSAGES_PER_CONVERSATION_PER_HOUR,
  maxConversationsPerIpPerHour: config.MAX_CONVERSATIONS_PER_IP_PER_HOUR,
  playground: config.PLAYGROUND ? { title: `${config.PRODUCT_NAME} Support` } : undefined,
  site: config.SITE,
  identitySecret: config.IDENTITY_SECRET,
  turnstile: config.TURNSTILE_SITE_KEY && config.TURNSTILE_SECRET_KEY ? { siteKey: config.TURNSTILE_SITE_KEY, secretKey: config.TURNSTILE_SECRET_KEY } : undefined,
  productName: config.PRODUCT_NAME,
  email: replyEmails ? { replies: replyEmails, webhookSecret: config.RESEND_WEBHOOK_SECRET } : undefined,
  team: {
    db,
    productName: config.PRODUCT_NAME,
    discord:
      config.DISCORD_CLIENT_ID && config.DISCORD_CLIENT_SECRET
        ? {
            clientId: config.DISCORD_CLIENT_ID,
            clientSecret: config.DISCORD_CLIENT_SECRET,
            guildId: config.DISCORD_GUILD_ID,
            teamRoleId: config.DISCORD_TEAM_ROLE_ID,
          }
        : undefined,
    allowIds: config.TEAM_DISCORD_IDS,
    publicUrl: config.PUBLIC_URL,
    devLogin: config.TEAM_DEV_LOGIN,
    discordGuildId: config.DISCORD_GUILD_ID,
  },
});
if (!config.DISCORD_CLIENT_ID && !config.TEAM_DEV_LOGIN) console.log("team: needs you: set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET to sign in to the dashboard at /admin");
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

/** One line per profile on boot, plus anything that won't work the way the settings read. */
function describeSettings() {
  const names = new Set(["default", ...Object.keys(settings.profiles)]);
  for (const name of names) {
    const prof = settings.profiles[name] ?? {};
    const ai = prof.ai === false || !agent ? "goes to the team" : `assistant on ${prof.model ?? config.AGENT_MODEL}`;
    const budget = prof.budget !== undefined ? `, $${prof.budget}/${prof.budgetScope === "shared" ? "month shared by everyone" : "person/month"}` : "";
    console.log(`profiles: ${name}: ${ai}${budget}`);
    if (prof.budget !== undefined && agent && prof.ai !== false && !priceFor(prof.model ?? model, settings.budgets.prices)) {
      console.log(`profiles: needs you: no price known for ${prof.model ?? model}; counting it at a high rate. Add it under budgets.prices.`);
    }
  }
  if (Object.values(settings.profiles).some((p) => p.botCheck) && !(config.TURNSTILE_SITE_KEY && config.TURNSTILE_SECRET_KEY)) {
    console.log("profiles: needs you: a profile has botCheck, but TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY aren't set, so its visitors go straight to the team");
  }
  const usesSignIn = settings.rules.some((r) => r.when.signedIn !== undefined || r.when.plan);
  if (usesSignIn && !config.IDENTITY_SECRET) {
    console.log("profiles: needs you: rules check sign-in or plan, but IDENTITY_SECRET isn't set, so nobody counts as signed in");
  }
}
