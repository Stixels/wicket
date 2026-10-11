/**
 * Discord server setup: a public community plus a private support inbox.
 * Idempotent: it matches roles and channels by name and only creates what's missing,
 * so it runs on every boot and never changes or deletes existing channels.
 *
 * The bot needs Manage Roles and Manage Channels for this.
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
  type Role,
} from "discord.js";

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

export interface SetupResult {
  supportInboxId: string;
  helpId: string;
  teamRoleId: string;
  /** Names of what this run created; empty when everything already existed. */
  created: string[];
  hasCommunity: boolean;
}

export async function setupGuild(token: string, guildId: string, teamRoleName = "Team"): Promise<SetupResult> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const ready = new Promise<void>((resolve) => client.once("clientReady", () => resolve()));
  await client.login(token);
  await ready;
  try {
    const guild = await client.guilds.fetch(guildId);
    await guild.channels.fetch();
    await guild.roles.fetch();
    const botId = client.user!.id;
    const created: string[] = [];

    let team = guild.roles.cache.find((r) => r.name === teamRoleName);
    if (!team) {
      team = await guild.roles.create({ name: teamRoleName, hoist: true, mentionable: true, reason: "Support team" });
      created.push(`@${teamRoleName}`);
    }

    const hasCommunity = guild.features.includes("COMMUNITY");
    const ids: Record<string, string> = {};

    for (const group of LAYOUT) {
      const teamOnly = group.channels.every((c) => c.access === "team");
      let category = find(guild, group.category, ChannelType.GuildCategory) as CategoryChannel | undefined;
      if (!category) {
        category = await guild.channels.create({
          name: group.category,
          type: ChannelType.GuildCategory,
          permissionOverwrites: teamOnly ? overwrites(guild, team, botId, "team") : undefined,
        });
        created.push(group.category);
      }

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
            permissionOverwrites: overwrites(guild, team, botId, spec.access),
            ...(spec.tags ? { availableTags: spec.tags.map((name) => ({ name })) } : {}),
          } as any);
          created.push(`#${spec.name}`);
        }
        ids[spec.name] = channel.id;
      }
    }

    return { supportInboxId: ids["support-inbox"], helpId: ids["help"], teamRoleId: team.id, created, hasCommunity };
  } finally {
    await client.destroy();
  }
}

function overwrites(guild: Guild, team: Role, botId: string, access: ChannelSpec["access"]): OverwriteResolvable[] {
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
