/**
 * One-time Discord server setup: a public community plus a private support inbox.
 * Safe to re-run; it only creates what's missing (matched by name).
 *
 *   DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... npm run discord:setup
 *
 * The bot needs Manage Roles and Manage Channels for this step only.
 */
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits as P,
  type CategoryChannel,
  type Guild,
  type GuildBasedChannel,
  type OverwriteResolvable,
} from "discord.js";

const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
const teamRoleName = process.env.DISCORD_TEAM_ROLE ?? "Team";
if (!token || !guildId) {
  console.error("Set DISCORD_BOT_TOKEN and DISCORD_GUILD_ID");
  process.exit(1);
}

type Kind = "text" | "forum" | "announcement";
interface ChannelSpec {
  name: string;
  kind: Kind;
  topic: string;
  access: "public" | "read-only" | "team";
  tags?: string[];
}

const LAYOUT: { category: string; channels: ChannelSpec[] }[] = [
  {
    category: "Start here",
    channels: [
      { name: "welcome", kind: "text", access: "read-only", topic: "Who we are, the rules, and where to ask for help." },
      { name: "announcements", kind: "announcement", access: "read-only", topic: "Releases and product updates." },
    ],
  },
  {
    category: "Community",
    channels: [
      { name: "general", kind: "text", access: "public", topic: "Chat with other operators." },
      {
        name: "help",
        kind: "forum",
        access: "public",
        topic: "Ask a question. The assistant answers from the docs first, and the team and community jump in.",
        tags: ["Question", "Bug", "Solved"],
      },
      {
        name: "ideas",
        kind: "forum",
        access: "public",
        topic: "Suggest features and vote with reactions.",
        tags: ["Idea", "Planned", "Shipped"],
      },
      { name: "show-and-tell", kind: "text", access: "public", topic: "Share your rooms, props and builds." },
    ],
  },
  {
    category: "Team",
    channels: [
      {
        name: "support-inbox",
        kind: "forum",
        access: "team",
        topic: "Every in-app conversation lands here. Reply in a post to answer the user in the app.",
        tags: ["Needs a person", "Bug", "Idea", "Question", "Resolved"],
      },
      { name: "team-chat", kind: "text", access: "team", topic: "Internal." },
    ],
  },
];

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(token);
await new Promise<void>((resolve) => client.once("clientReady", () => resolve()));
const guild = await client.guilds.fetch(guildId);
await guild.channels.fetch();
const botId = client.user!.id;

const team =
  guild.roles.cache.find((r) => r.name === teamRoleName) ??
  (await guild.roles.create({ name: teamRoleName, hoist: true, mentionable: true, reason: "Support team" }));
log(`role @${team.name}`, team.id);

const hasCommunity = guild.features.includes("COMMUNITY");
const created: Record<string, string> = {};

for (const group of LAYOUT) {
  const teamOnly = group.channels.every((c) => c.access === "team");
  const category =
    (find(guild, group.category, ChannelType.GuildCategory) as CategoryChannel | undefined) ??
    (await guild.channels.create({
      name: group.category,
      type: ChannelType.GuildCategory,
      permissionOverwrites: teamOnly ? overwrites("team") : undefined,
    }));
  log(`category ${group.category}`, category.id);

  for (const spec of group.channels) {
    const type =
      spec.kind === "forum"
        ? ChannelType.GuildForum
        : spec.kind === "announcement" && hasCommunity
          ? ChannelType.GuildAnnouncement
          : ChannelType.GuildText;
    let channel = find(guild, spec.name, type) ?? find(guild, spec.name, ChannelType.GuildText);
    if (!channel) {
      channel = await guild.channels.create({
        name: spec.name,
        type: type as ChannelType.GuildText,
        parent: category.id,
        topic: spec.topic,
        permissionOverwrites: overwrites(spec.access),
        ...(spec.tags ? { availableTags: spec.tags.map((name) => ({ name })) } : {}),
      } as any);
    }
    created[spec.name] = channel.id;
    log(`#${spec.name}`, channel.id);
  }
}

console.log("\nAdd these to your service variables:\n");
console.log(`DISCORD_CHANNEL_ID=${created["support-inbox"]}`);
console.log(`DISCORD_COMMUNITY_HELP_CHANNEL_ID=${created["help"]}`);
console.log(`DISCORD_HANDOFF_MENTION=<@&${team.id}>`);
console.log(`\nThen give your teammates the @${team.name} role.`);
if (!hasCommunity) {
  console.log("Tip: turn on Community in Server Settings to get a real announcement channel and a welcome screen.");
}
await client.destroy();

function overwrites(access: ChannelSpec["access"]): OverwriteResolvable[] {
  const everyone = guild.roles.everyone.id;
  const bot: OverwriteResolvable = {
    id: botId,
    allow: [P.ViewChannel, P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads, P.ManageThreads, P.ReadMessageHistory, P.AddReactions],
  };
  if (access === "team") {
    return [
      { id: everyone, deny: [P.ViewChannel] },
      { id: team.id, allow: [P.ViewChannel, P.SendMessages, P.SendMessagesInThreads, P.ReadMessageHistory] },
      bot,
    ];
  }
  if (access === "read-only") {
    return [
      { id: everyone, deny: [P.SendMessages, P.CreatePublicThreads], allow: [P.ViewChannel, P.ReadMessageHistory] },
      { id: team.id, allow: [P.SendMessages] },
      bot,
    ];
  }
  return [bot];
}

function find(g: Guild, name: string, type: ChannelType): GuildBasedChannel | undefined {
  return g.channels.cache.find((c) => c.name.toLowerCase() === name.toLowerCase() && c.type === type);
}

function log(what: string, id: string) {
  console.log(`✓ ${what.padEnd(28)} ${id}`);
}
