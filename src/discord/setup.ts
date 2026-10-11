/**
 * Discord server setup: a public community plus a private support inbox.
 * Idempotent: it matches roles and channels by name (ignoring any emoji prefix) and only creates
 * what's missing, so it runs on every boot. It never deletes anything. On channels it manages it
 * fills in an empty topic, adds the emoji prefix while the channel still has its plain name, keeps
 * "Start here" at the top so new members land in #welcome, and keeps one pinned welcome post current.
 *
 * The bot needs Manage Roles and Manage Channels for this. Manage Server is optional: with it,
 * #welcome also becomes the system channel and the Community welcome screen.
 */
import {
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits as P,
  type CategoryChannel,
  type Guild,
  type GuildBasedChannel,
  type ForumChannel,
  type OverwriteResolvable,
  type Role,
  type TextChannel,
} from "discord.js";

export const VOICE_HUB_NAME = "➕ Start a call";
export const SUPPORT_VOICE_HUB_NAME = "🎧 Talk to support";

type Kind = "text" | "forum" | "announcement" | "voice";
interface ChannelSpec {
  name: string;
  /** Shown before the name, e.g. "👋" makes "👋・welcome". */
  emoji?: string;
  kind: Kind;
  topic: string;
  access: "public" | "read-only" | "team";
  tags?: { name: string; emoji: string }[];
  /** Earlier default topics, replaced with the current one since nobody chose them by hand. */
  oldTopics?: string[];
  /** Forums only: the reaction every new post starts with. */
  reaction?: string;
}

const LAYOUT: { category: string; channels: ChannelSpec[] }[] = [
  {
    category: "Start here",
    channels: [
      { name: "welcome", emoji: "👋", kind: "text", access: "read-only", topic: "Start here: who we are, the house rules, and where to get help." },
      { name: "announcements", emoji: "📣", kind: "announcement", access: "read-only", topic: "Releases, new features and anything you should know about. Follow it to get updates in your own server." },
    ],
  },
  {
    category: "Support",
    channels: [
      {
        name: "help",
        emoji: "❓",
        kind: "forum",
        access: "public",
        topic:
          "One post per question, with a clear title. Add screenshots and what you already tried. " +
          "The assistant answers from the docs right away, and the team and community follow up. " +
          "Tag it Solved when you're sorted so others can find the answer.",
        tags: [
          { name: "Question", emoji: "❓" },
          { name: "Bug", emoji: "🐛" },
          { name: "Solved", emoji: "✅" },
        ],
      },
      // Join-to-create, but the room is private to the caller and the team, and the team is pinged.
      { name: SUPPORT_VOICE_HUB_NAME, kind: "voice", access: "public", topic: "" },
    ],
  },
  {
    category: "Community",
    channels: [
      { name: "general", emoji: "💬", kind: "text", access: "public", topic: "Hang out with other escape room operators. Say hi and tell us about your rooms!" },
      {
        name: "ideas",
        emoji: "💡",
        kind: "forum",
        access: "public",
        topic:
          "One idea per post. Say what you're trying to do and why, not only the feature. " +
          "Vote with 👍 on the ideas you want. Search first, and add to an existing post if it's already there.",
        tags: [
          { name: "Idea", emoji: "💡" },
          { name: "Planned", emoji: "🗓️" },
          { name: "Shipped", emoji: "🚀" },
        ],
        reaction: "👍",
      },
      { name: "show-and-tell", emoji: "📸", kind: "text", access: "public", topic: "Show off your rooms, puzzles, props and builds. Photos and videos welcome." },
      // Join-to-create: joining this makes a room for you and moves you in.
      { name: VOICE_HUB_NAME, kind: "voice", access: "public", topic: "" },
    ],
  },
  {
    category: "Team",
    channels: [
      {
        name: "support-inbox",
        kind: "forum",
        access: "team",
        topic:
          "Every in-app conversation lands here. Reply in a post to answer the user in the app. " +
          "Close the post (or tag it Resolved) when you're done: the user is told, and it reopens if they write again.",
        oldTopics: ["Every in-app conversation lands here. Reply in a post to answer the user in the app."],
        tags: [
          { name: "Needs a person", emoji: "🙋" },
          { name: "Bug", emoji: "🐛" },
          { name: "Idea", emoji: "💡" },
          { name: "Question", emoji: "❓" },
          { name: "Resolved", emoji: "✅" },
        ],
      },
      { name: "team-chat", kind: "text", access: "team", topic: "Internal." },
    ],
  },
];

/** "👋・welcome" for specs with an emoji, otherwise the plain name. */
function displayName(spec: ChannelSpec) {
  return spec.emoji ? `${spec.emoji}・${spec.name}` : spec.name;
}

export interface SetupResult {
  supportInboxId: string;
  helpId: string;
  voiceHubId: string;
  supportVoiceHubId: string;
  teamRoleId: string;
  /** Names of what this run created; empty when everything already existed. */
  created: string[];
  /** Things the bot couldn't do itself, phrased as steps for the server owner. */
  manual: string[];
  hasCommunity: boolean;
}

export interface SetupOptions {
  teamRoleName?: string;
  productName?: string;
  docsUrl?: string;
  /** Embed color for the welcome post. */
  color?: number;
}

export async function setupGuild(token: string, guildId: string, opts: SetupOptions = {}): Promise<SetupResult> {
  const teamRoleName = opts.teamRoleName ?? "Team";
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
    const manual: string[] = [];

    let team = guild.roles.cache.find((r) => r.name === teamRoleName);
    if (!team) {
      team = await guild.roles.create({ name: teamRoleName, hoist: true, mentionable: true, reason: "Support team" });
      created.push(`@${teamRoleName}`);
    }

    const hasCommunity = guild.features.includes("COMMUNITY");
    const ids: Record<string, string> = {};

    // Discord's notices to admins belong in the private team channel, not a public one (needs Manage Server).
    const teamChat = find(guild, "team-chat", ChannelType.GuildText);
    let noticesId = guild.publicUpdatesChannelId;
    const notices0 = noticesId ? guild.channels.cache.get(noticesId) : undefined;
    if (hasCommunity && teamChat && notices0 && notices0.id !== teamChat.id && notices0.parent?.name.toLowerCase() !== "team") {
      await guild.setPublicUpdatesChannel(teamChat.id).then(
        () => {
          noticesId = teamChat.id;
          created.push(`Discord's admin notices now go to #team-chat`);
        },
        () => {},
      );
    }

    const managed = new Set(LAYOUT.map((g) => g.category.toLowerCase()));
    let previous: CategoryChannel | undefined;
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
        // Place a new category right after the one before it in the layout.
        if (previous) await category.setPosition(previous.position + 1).catch(() => {});
      }
      previous = category;

      for (const spec of group.channels) {
        const type =
          spec.kind === "voice"
            ? ChannelType.GuildVoice
            : spec.kind === "forum"
            ? ChannelType.GuildForum
            : spec.kind === "announcement" && hasCommunity
              ? ChannelType.GuildAnnouncement
              : ChannelType.GuildText;
        let channel: GuildBasedChannel | undefined = find(guild, spec.name, type) ?? find(guild, spec.name, ChannelType.GuildText);
        if (!channel) {
          channel = await guild.channels.create({
            name: displayName(spec),
            type: type as ChannelType.GuildText,
            parent: category.id,
            ...(spec.topic ? { topic: spec.topic } : {}),
            permissionOverwrites: overwrites(guild, team, botId, spec.access),
            ...(spec.tags ? { availableTags: spec.tags.map((t) => ({ name: t.name, emoji: { name: t.emoji } })) } : {}),
            ...(spec.reaction ? { defaultReactionEmoji: { name: spec.reaction } } : {}),
          } as any);
          created.push(`#${displayName(spec)}`);
        } else {
          if ("parentId" in channel && channel.parentId !== category.id && channel.parent && managed.has(channel.parent.name.toLowerCase())) {
            // Moved between our own categories in a later version of the layout. Channels the server
            // owner placed elsewhere are left alone.
            await (channel as any).setParent(category.id, { lockPermissions: false });
            created.push(`moved #${spec.name} to ${group.category}`);
          }
          created.push(...(await freshen(channel, spec).catch(() => [])));
          // Community servers get real announcement channels, which people can follow from their own servers.
          // Discord requires the rules and admin-notices channels to stay plain text channels.
          const reserved = [guild.rulesChannelId, noticesId].includes(channel.id);
          if (spec.kind === "announcement" && hasCommunity && channel.type === ChannelType.GuildText && !reserved) {
            channel = await (channel as TextChannel).setType(ChannelType.GuildAnnouncement).then(
              (c) => (created.push(`made #${spec.name} an announcement channel`), c),
              () => channel!,
            );
          }
          if (channel.id === noticesId && spec.access !== "team") {
            manual.push(`Discord's admin notices go to the public #${channel.name}. Server Settings > Community > Overview: set Community Updates Channel to #team-chat`);
          }
        }
        ids[spec.name] = channel.id;
      }
    }

    // New members land in the first channel they can see, so "Start here" goes to the top
    // and #welcome first inside it.
    const start = find(guild, LAYOUT[0].category, ChannelType.GuildCategory) as CategoryChannel;
    const topCategory = guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildCategory)
      .sort((a, b) => (a as CategoryChannel).position - (b as CategoryChannel).position)
      .first();
    if (topCategory && topCategory.id !== start.id) {
      await start.setPosition(0).catch(() => {});
      created.push(`moved ${LAYOUT[0].category} to the top`);
    }
    const welcome = guild.channels.cache.get(ids["welcome"]) as TextChannel;

    // Community servers have a rules channel and a channel for Discord's notices to admins.
    const rules = guild.rulesChannelId ? (guild.channels.cache.get(guild.rulesChannelId) as TextChannel | undefined) : undefined;
    if (rules && rules.id !== welcome.id) {
      ids["rules"] = rules.id;
      created.push(...(await freshen(rules, RULES_SPEC).catch(() => [])));
      if (rules.parentId !== start.id && (!rules.parent || managed.has(rules.parent.name.toLowerCase()))) {
        await rules.setParent(start.id, { lockPermissions: false }).then(() => created.push(`moved #${rules.name} to ${LAYOUT[0].category}`), () => {});
      }
      if (!rules.permissionOverwrites.cache.size) await rules.permissionOverwrites.set(overwrites(guild, team, botId, "read-only")).catch(() => {});
      // Discord's own rules channel may not let the bot post yet.
      await rules.permissionOverwrites
        .edit(botId, { ViewChannel: true, SendMessages: true, EmbedLinks: true, ReadMessageHistory: true })
        .catch(() => {});
      const post = await keepPost(rules, botId, rulesEmbed(opts, ids, team.id), RULES_FOOTER).catch((err) => {
        manual.push(`Let the bot post in #${rules.name} (Send Messages and Embed Links) so it can add the rules (${err?.message ?? err})`);
        return null;
      });
      if (post) created.push(`${post} in #${rules.name}`);
    }
    const notices = noticesId ? guild.channels.cache.get(noticesId) : undefined;
    const teamCategory = find(guild, "Team", ChannelType.GuildCategory);
    if (notices && !notices.parentId && teamCategory && "setParent" in notices) {
      await notices.setParent(teamCategory.id, { lockPermissions: false }).then(() => created.push(`moved #${notices.name} to Team`), () => {});
    }

    // Order inside Start here: welcome, rules, announcements, then anything else.
    const first = [ids["welcome"], ids["rules"], ids["announcements"]].filter(Boolean);
    const siblings = guild.channels.cache
      .filter((c) => c.parentId === start.id && c.type !== ChannelType.GuildVoice && "position" in c)
      .sort((a, b) => (a as TextChannel).position - (b as TextChannel).position)
      .map((c) => c.id);
    const wanted = [...first.filter((id) => siblings.includes(id)), ...siblings.filter((id) => !first.includes(id))];
    if (wanted.join() !== siblings.join()) {
      await guild.channels.setPositions(wanted.map((channel, position) => ({ channel, position }))).catch(() => {});
    }

    const post = await keepPost(welcome, botId, welcomeEmbed({ ...opts, ids }), WELCOME_FOOTER).catch(() => {
      manual.push("Give the bot Send Messages and Embed Links in #welcome so it can post the welcome message");
      return null;
    });
    if (post) created.push(`${post} in #welcome`);
    // Channels outside any category sit above every category, so new members would land there instead.
    const loose = guild.channels.cache.filter((c) => !c.parentId && c.type !== ChannelType.GuildCategory && c.type !== ChannelType.GuildVoice);
    if (loose.size) manual.push(`Move ${loose.map((c) => `#${c.name}`).join(", ")} into a category so #welcome is the first channel people see`);

    // Join messages and the Community welcome screen point at #welcome. Both need Manage Server.
    if (guild.systemChannelId !== welcome.id) {
      await guild
        .setSystemChannel(welcome.id)
        .then(() => created.push("system messages now go to #welcome"))
        .catch(() => manual.push("Server Settings > Engagement: set System Messages Channel to #welcome"));
    }
    if (hasCommunity) {
      await guild
        .editWelcomeScreen({
          enabled: true,
          description: `The ${opts.productName ?? "product"} community. Get help, share ideas and meet other operators.`,
          welcomeChannels: [
            { channel: ids["welcome"], description: "Start here and read the house rules", emoji: "👋" },
            { channel: ids["help"], description: "Ask a question and get an answer fast", emoji: "❓" },
            { channel: ids["ideas"], description: "Suggest features and vote on others", emoji: "💡" },
            { channel: ids["general"], description: "Say hi to other operators", emoji: "💬" },
          ],
        })
        .catch(() => manual.push("Server Settings > Onboarding: turn on the welcome screen with #welcome, #help, #ideas and #general"));
    } else {
      manual.push("Server Settings > Enable Community, which turns on the welcome screen and onboarding (the bot sets them up on the next deploy if it has Manage Server)");
    }

    return { supportInboxId: ids["support-inbox"], helpId: ids["help"], voiceHubId: ids[VOICE_HUB_NAME], supportVoiceHubId: ids[SUPPORT_VOICE_HUB_NAME], teamRoleId: team.id, created, manual, hasCommunity };
  } finally {
    await client.destroy();
  }
}

function overwrites(guild: Guild, team: Role, botId: string, access: ChannelSpec["access"]): OverwriteResolvable[] {
  const everyone = guild.roles.everyone.id;
  const bot: OverwriteResolvable = {
    id: botId,
    allow: [P.ViewChannel, P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads, P.ManageThreads, P.ReadMessageHistory, P.AddReactions, P.EmbedLinks],
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

/** Matches "welcome", "👋・welcome" and "👋┃welcome" alike. */
function plain(name: string) {
  return name.toLowerCase().replace(/^[^\p{L}\p{N}]+/u, "");
}

function find(g: Guild, name: string, type: ChannelType): GuildBasedChannel | undefined {
  return g.channels.cache.find((c) => plain(c.name) === plain(name) && c.type === type);
}

/** Brings an existing channel up to the layout without overriding anything the owner chose. */
async function freshen(channel: GuildBasedChannel, spec: ChannelSpec): Promise<string[]> {
  const done: string[] = [];
  const c = channel as TextChannel;
  if (spec.emoji && channel.name === spec.name) {
    await c.setName(displayName(spec));
    done.push(`renamed #${spec.name} to #${displayName(spec)}`);
  }
  if (spec.topic && "topic" in c && (!c.topic || spec.oldTopics?.includes(c.topic))) {
    await c.setTopic(spec.topic);
    done.push(`topic on #${spec.name}`);
  }
  if (channel.type === ChannelType.GuildForum) {
    const c = channel as ForumChannel;
    if (spec.tags && !c.availableTags.length) {
      await c.setAvailableTags(spec.tags.map((t) => ({ name: t.name, emoji: { id: null, name: t.emoji } })));
      done.push(`tags on #${spec.name}`);
    }
    if (spec.reaction && !c.defaultReactionEmoji) {
      await c.setDefaultReactionEmoji({ id: null, name: spec.reaction });
      done.push(`${spec.reaction} on new #${spec.name} posts`);
    }
  }
  return done;
}

const WELCOME_FOOTER = "Pinned by the support bot";
const RULES_FOOTER = "Server rules · kept up to date by the support bot";

const RULES_SPEC: ChannelSpec = {
  name: "rules",
  emoji: "📜",
  kind: "text",
  access: "read-only",
  topic: "The house rules. By chatting here you agree to them.",
};

const HOUSE_RULES = [
  "**Be kind.** Treat everyone with respect. No harassment, hate speech or personal attacks.",
  "**Use the right channel.** Questions go in the help forum, feature requests in ideas, everything else in general.",
  "**Search first.** If someone already asked, add to that post instead of opening a new one.",
  "**Protect privacy.** Never post passwords, payment details or your players' personal info. The team will never ask for your password.",
  "**No spam.** No scams, unsolicited DMs or self-promotion.",
  "**Keep it safe for work.**",
];

function welcomeEmbed(o: SetupOptions & { ids: Record<string, string> }) {
  const ch = (name: string) => (o.ids[name] ? `<#${o.ids[name]}>` : `#${name}`);
  const product = o.productName ?? "our product";
  return new EmbedBuilder()
    .setColor(o.color ?? 0xe8590c)
    .setTitle(`Welcome to the ${product} community 👋`)
    .setDescription(`This is where ${product} users get help, swap ideas and meet other operators. Here's how to find your way around.`)
    .addFields(
      {
        name: "❓ Get help",
        value: `Post in ${ch("help")}. The assistant answers from the docs right away, and the team follows up when it can't.${o.docsUrl ? ` You can also browse the [docs](${o.docsUrl}).` : ""}`,
      },
      { name: "🎧 Talk to us", value: `Join ${ch(SUPPORT_VOICE_HUB_NAME)} for a private call, and the team gets a ping.` },
      { name: "💡 Shape the product", value: `Suggest features in ${ch("ideas")} and 👍 the ones you want most.` },
      { name: "💬 Hang out", value: `Chat in ${ch("general")}, show your builds in ${ch("show-and-tell")}, or join ${ch(VOICE_HUB_NAME)} to open a voice room.` },
      { name: "📣 Stay in the loop", value: `Releases and updates go in ${ch("announcements")}.` },
      o.ids["rules"]
        ? { name: "📜 House rules", value: `Please read ${ch("rules")} before you post.` }
        : { name: "📜 House rules", value: HOUSE_RULES.map((r, i) => `${i + 1}. ${r}`).join("\n") },
    )
    .setFooter({ text: WELCOME_FOOTER });
}

function rulesEmbed(o: SetupOptions, ids: Record<string, string>, teamRoleId: string) {
  const ch = (name: string) => (ids[name] ? `<#${ids[name]}>` : `#${name}`);
  return new EmbedBuilder()
    .setColor(o.color ?? 0xe8590c)
    .setTitle("📜 House rules")
    .setDescription(
      [
        `We want this to be the friendliest place to talk about ${o.productName ?? "the product"}. A few rules keep it that way:`,
        "",
        ...HOUSE_RULES.map((r, i) => `**${i + 1}.** ${r}`),
        `**${HOUSE_RULES.length + 1}.** **Follow Discord's rules.** The [Terms of Service](https://discord.com/terms) and [Community Guidelines](https://discord.com/guidelines) apply here too.`,
        "",
        `If something's wrong, mention <@&${teamRoleId}> or message a team member. We may remove posts or people that break these rules.`,
        "",
        `Need help with ${o.productName ?? "the product"}? Head to ${ch("help")}.`,
      ].join("\n"),
    )
    .setFooter({ text: RULES_FOOTER });
}

/** Keeps one bot post with this footer in a channel: posts and pins it once, then edits it when the text changes. */
async function keepPost(channel: TextChannel, botId: string, embed: EmbedBuilder, footer: string): Promise<string | null> {
  const recent = await channel.messages.fetch({ limit: 50 });
  const mine = recent.find((m) => m.author.id === botId && m.embeds[0]?.footer?.text === footer);
  const text = (e: { title?: string | null; description?: string | null; fields?: { name: string; value: string }[] }) =>
    [e.title, e.description, ...(e.fields ?? []).map((f) => `${f.name}\n${f.value}`)].join("\n");
  if (mine) {
    if (text(mine.embeds[0]) === text(embed.data)) return null;
    await mine.edit({ embeds: [embed] });
    return "updated the post";
  }
  const msg = await channel.send({ embeds: [embed] });
  const pinned = await msg.pin().then(() => true, () => false);
  return pinned ? "posted and pinned" : "posted (pinning needs Manage Messages)";
}
