import {
  AttachmentBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  SnowflakeUtil,
  GatewayIntentBits,
  type ForumChannel,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { ThreadGoneError, type Relay, type RelayConversation, type RelayFile, type StaffReply } from "../types.js";
import { MAX_FILE_BYTES, allowedType } from "../../files.js";
import { attachVoiceRooms, type VoiceHub } from "../../discord/voiceRooms.js";
import { attachTicketCommand, mentionsBot, type TicketCommandOptions } from "../../discord/tickets.js";

export interface DiscordRelayOptions {
  token: string;
  /** A forum channel (one post per conversation) or a text channel (one thread per conversation). */
  channelId: string;
  /** Prepended when the agent asks for a person, e.g. "<@&123>" for a role or "@here". */
  handoffMention?: string;
  /** Public help forum where the assistant answers each new post once from the docs. */
  communityHelpChannelId?: string;
  answerCommunityPost?: (question: string) => Promise<{ reply: string; needsHuman: boolean } | null>;
  /** Join-to-create voice channels. */
  voiceHubs?: VoiceHub[];
  /** Lets the team tag the bot to file a ticket from a conversation. */
  tickets?: TicketCommandOptions;
}

const NEEDS_PERSON_TAG = "needs a person";
const RESOLVED_TAG = "resolved";

const LIMIT = 1900; // Discord's hard limit is 2000 characters
const EMBED_LIMIT = 4000; // embed descriptions allow 4096

// The user and the assistant show as colored cards; the team's own replies stay plain messages,
// so it's easy to see at a glance who said what.
const COLOR = { user: 0x5865f2, agent: 0x8b8f98 } as const;

/**
 * Each in-app conversation becomes a forum post (or thread). Anything the team
 * writes in it goes back to the user's widget, and the assistant steps aside.
 * Needs the Message Content intent turned on for the bot in the Discord developer portal.
 */
export class DiscordRelay implements Relay {
  name = "discord";
  private client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  constructor(private opts: DiscordRelayOptions) {
    if (opts.voiceHubs?.length) attachVoiceRooms(this.client, opts.voiceHubs);
    if (opts.tickets) attachTicketCommand(this.client, opts.tickets);
  }

  async start(onStaffReply: (reply: StaffReply) => Promise<void>, onResolved?: (threadId: string, deleted?: boolean) => Promise<boolean>): Promise<void> {
    this.client.on(Events.MessageCreate, async (message: Message) => {
      if (message.author.bot || message.system || !message.channel.isThread()) return;
      if (message.channel.parentId !== this.opts.channelId) return;
      if (this.opts.tickets && mentionsBot(message)) return; // a note to the bot, not a reply to the user
      try {
        // Discord's file links expire, so the files are copied into Wicket's own store.
        const files = await downloadAttachments(message);
        const skipped = message.attachments.size - files.length;
        const body = [message.content, skipped ? `(${skipped} file${skipped === 1 ? "" : "s"} too large or not allowed to send)` : ""].filter(Boolean).join("\n");
        if (!body.trim() && !files.length) return;
        await onStaffReply({
          threadId: message.channel.id,
          authorName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
          body,
          files,
        });
        if (skipped) await message.react("📎").catch(() => {});
      } catch (err) {
        console.error("discord: failed to relay staff reply", err);
        await message.react("⚠️").catch(() => {});
      }
    });
    if (onResolved) {
      // Closing a post, or tagging it Resolved, resolves the conversation in the app.
      this.client.on(Events.ThreadUpdate, async (before, after) => {
        if (after.parentId !== this.opts.channelId) return;
        const closed = !before.archived && after.archived && !this.autoArchived(after);
        const tagged = this.hasTag(after, RESOLVED_TAG) && !this.hasTag(before, RESOLVED_TAG);
        if (!before.archived && after.archived && !closed) console.log(`discord: post "${after.name}" auto-archived after inactivity, left open`);
        if (closed || tagged) {
          const done = await onResolved(after.id).catch((err) => (console.error("discord: failed to resolve", err), false));
          if (done) console.log(`discord: post "${after.name}" ${closed ? "closed" : "tagged Resolved"}, conversation resolved`);
        }
      });
      // Deleting a post also resolves it; a new message from the user then opens a fresh post.
      this.client.on(Events.ThreadDelete, async (thread) => {
        if (thread.parentId !== this.opts.channelId) return;
        await onResolved(thread.id, true).catch((err) => console.error("discord: failed to resolve", err));
        console.log(`discord: post "${thread.name}" deleted, conversation resolved`);
      });
    }
    if (this.opts.communityHelpChannelId && this.opts.answerCommunityPost) {
      this.client.on(Events.ThreadCreate, (thread, newlyCreated) => {
        if (newlyCreated && thread.parentId === this.opts.communityHelpChannelId) void this.answerPost(thread);
      });
    }
    const ready = new Promise<void>((resolve) => this.client.once(Events.ClientReady, () => resolve()));
    await this.client.login(this.opts.token);
    await ready;
    // Fail fast on a wrong channel id or missing permissions.
    await this.channel();
  }

  async openThread(c: RelayConversation, firstMessage: string): Promise<string> {
    const who = c.reporterName ?? c.reporterEmail ?? "Anonymous user";
    const name = `${who}: ${firstMessage.replace(/\s+/g, " ")}`.slice(0, 95);
    const about = new EmbedBuilder()
      .setColor(COLOR.user)
      .setTitle(who)
      .setDescription(c.reporterEmail && c.reporterName ? c.reporterEmail : null)
      .addFields(contextFields(c.context))
      .setFooter({ text: "Reply here to answer them in the app. The assistant stops once someone from the team replies. Close the post when you're done." });

    const channel = await this.channel();
    const message = { embeds: [about, card("user", firstMessage, c.reporterName)], allowedMentions: { parse: [] } };
    let thread: ThreadChannel;
    if (channel.type === ChannelType.GuildForum) {
      thread = await (channel as ForumChannel).threads.create({ name, message });
    } else {
      const starter = await (channel as TextChannel).send(message);
      thread = await starter.startThread({ name });
    }
    return thread.id;
  }

  async post(threadId: string, author: "user" | "agent" | "system", body: string, authorName?: string | null, files: RelayFile[] = []): Promise<void> {
    const thread = await this.thread(threadId);
    const attachments = files.map((f) => new AttachmentBuilder(f.data, { name: f.name }));
    if (author === "system" || !body.trim()) {
      const content = author === "system" ? `-# ${body}` : `-# 📎 ${files.length === 1 ? "Attachment" : `${files.length} attachments`}`;
      await thread.send({ content: content.slice(0, LIMIT), files: attachments, allowedMentions: { parse: [] } });
      return;
    }
    await thread.send({ embeds: [card(author, body, authorName, this.client.user?.displayAvatarURL())], files: attachments, allowedMentions: { parse: [] } });
  }

  async typing(threadId: string): Promise<void> {
    await (await this.thread(threadId)).sendTyping();
  }

  async markResolved(threadId: string): Promise<void> {
    const thread = await this.thread(threadId); // unarchives it so we can post
    await thread.send({ content: "-# ✅ Resolved. They've been told in the app, and this post reopens if they write again.", allowedMentions: { parse: [] } });
    await this.setTags(thread, [RESOLVED_TAG], [NEEDS_PERSON_TAG]);
    await thread.setArchived(true).catch(() => {});
  }

  async reopen(threadId: string): Promise<void> {
    const thread = await this.thread(threadId);
    await this.setTags(thread, [], [RESOLVED_TAG]);
  }

  async requestHuman(threadId: string, reason: string): Promise<void> {
    const thread = await this.thread(threadId);
    const mention = this.opts.handoffMention ? `${this.opts.handoffMention} ` : "";
    await thread.send({
      content: `${mention}🙋 **Needs a person:** ${reason}`.slice(0, LIMIT),
      allowedMentions: { parse: ["roles", "users", "everyone"] },
    });
    await this.setTags(thread, [NEEDS_PERSON_TAG], [RESOLVED_TAG]);
  }

  private async answerPost(thread: ThreadChannel) {
    try {
      const starter = await thread.fetchStarterMessage().catch(() => null);
      if (!starter || starter.author.bot) return;
      const question = `${thread.name}\n\n${starter.content}`.trim();
      const result = await this.opts.answerCommunityPost!(question);
      if (!result?.reply) return;
      const note = result.needsHuman && this.opts.handoffMention ? `\n\n${this.opts.handoffMention} can you take a look?` : "";
      for (const part of chunk(`${result.reply}${note}`)) {
        await thread.send({ content: part, allowedMentions: { parse: result.needsHuman ? ["roles", "everyone"] : [] } });
      }
    } catch (err) {
      console.error("discord: failed to answer community post", err);
    }
  }

  /** Adds and removes forum tags by name (e.g. "Needs a person"); tags the forum doesn't have are skipped. */
  private async setTags(thread: ThreadChannel, add: string[], remove: string[]) {
    const parent = thread.parent;
    if (parent?.type !== ChannelType.GuildForum) return;
    const ids = (names: string[]) =>
      (parent as ForumChannel).availableTags.filter((t) => names.includes(t.name.toLowerCase())).map((t) => t.id);
    const drop = new Set(ids(remove));
    const next = [...new Set([...thread.appliedTags.filter((t) => !drop.has(t)), ...ids(add)])].slice(-5);
    if (next.length === thread.appliedTags.length && next.every((t) => thread.appliedTags.includes(t))) return;
    await thread.setAppliedTags(next).catch(() => {});
  }

  private hasTag(thread: ThreadChannel, name: string) {
    const parent = thread.parent;
    if (parent?.type !== ChannelType.GuildForum) return false;
    const tag = (parent as ForumChannel).availableTags.find((t) => t.name.toLowerCase() === name);
    return Boolean(tag && thread.appliedTags.includes(tag.id));
  }

  /** Discord also archives posts after a stretch of inactivity; that isn't the team closing it. */
  private autoArchived(thread: ThreadChannel) {
    const last = thread.lastMessageId ? Number(SnowflakeUtil.timestampFrom(thread.lastMessageId)) : thread.createdTimestamp ?? 0;
    const idleMs = Date.now() - last;
    return idleMs >= (thread.autoArchiveDuration ?? 4320) * 60_000 - 5 * 60_000;
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  private async channel(): Promise<ForumChannel | TextChannel> {
    const ch = await this.client.channels.fetch(this.opts.channelId);
    if (!ch || (ch.type !== ChannelType.GuildForum && ch.type !== ChannelType.GuildText)) {
      throw new Error(`Discord channel ${this.opts.channelId} must be a forum or text channel`);
    }
    return ch as ForumChannel | TextChannel;
  }

  private async thread(id: string): Promise<ThreadChannel> {
    const ch = await this.client.channels.fetch(id).catch((err) => {
      if (err?.code === 10003) throw new ThreadGoneError(id); // Unknown Channel: the post was deleted
      throw err;
    });
    if (!ch?.isThread()) throw new ThreadGoneError(id);
    if (ch.archived) await ch.setArchived(false).catch(() => {});
    return ch;
  }
}

/** A colored card for a user or assistant message. */
/** Copies a message's files (up to Wicket's size limit and allowed types). */
async function downloadAttachments(message: Message): Promise<RelayFile[]> {
  const out: RelayFile[] = [];
  for (const a of message.attachments.values()) {
    const type = (a.contentType ?? "").split(";")[0]!.trim();
    if (a.size > MAX_FILE_BYTES || !allowedType(type)) continue;
    const res = await fetch(a.url).catch(() => null);
    if (!res?.ok) continue;
    out.push({ name: a.name, type, data: Buffer.from(await res.arrayBuffer()) });
  }
  return out;
}

function card(author: "user" | "agent", body: string, name?: string | null, avatar?: string) {
  const text = body.length > EMBED_LIMIT ? `${body.slice(0, EMBED_LIMIT)}…` : body;
  return new EmbedBuilder()
    .setColor(COLOR[author])
    .setAuthor(author === "agent" ? { name: "Assistant", iconURL: avatar } : { name: name ? `${name} (in the app)` : "User (in the app)" })
    .setDescription(text || "(empty message)");
}

/** App context as short inline fields, e.g. Page and App version. */
function contextFields(ctx: Record<string, unknown> | null) {
  if (!ctx) return [];
  const label = (k: string) => k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
  const fields = Object.entries(ctx)
    .filter(([, v]) => v !== null && v !== undefined && v !== "" && typeof v !== "object")
    .slice(0, 8)
    .map(([k, v]) => ({ name: label(k), value: String(v).slice(0, 200), inline: true }));
  const errors = Array.isArray(ctx.errors) ? ctx.errors.length : 0;
  if (errors) fields.push({ name: "Recent errors", value: String(errors), inline: true });
  return fields;
}

export { ThreadGoneError };

export function chunk(text: string, size = LIMIT): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}
