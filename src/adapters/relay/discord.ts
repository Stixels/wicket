import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type ForumChannel,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import type { Relay, RelayConversation, StaffReply } from "../types.js";

export interface DiscordRelayOptions {
  token: string;
  /** A forum channel (one post per conversation) or a text channel (one thread per conversation). */
  channelId: string;
  /** Prepended when the agent asks for a person, e.g. "<@&123>" for a role or "@here". */
  handoffMention?: string;
}

const LIMIT = 1900; // Discord's hard limit is 2000 characters

const LABEL = { user: "💬 **User**", agent: "🤖 **Assistant**", system: "ℹ️" } as const;

/**
 * Each in-app conversation becomes a forum post (or thread). Anything the team
 * writes in it goes back to the user's widget, and the assistant steps aside.
 * Needs the Message Content intent turned on for the bot in the Discord developer portal.
 */
export class DiscordRelay implements Relay {
  name = "discord";
  private client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  constructor(private opts: DiscordRelayOptions) {}

  async start(onStaffReply: (reply: StaffReply) => Promise<void>): Promise<void> {
    this.client.on(Events.MessageCreate, async (message: Message) => {
      if (message.author.bot || message.system || !message.channel.isThread()) return;
      if (message.channel.parentId !== this.opts.channelId) return;
      const body = [message.content, ...message.attachments.map((a) => a.url)].filter(Boolean).join("\n");
      if (!body.trim()) return;
      try {
        await onStaffReply({
          threadId: message.channel.id,
          authorName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
          body,
        });
        await message.react("✅").catch(() => {});
      } catch (err) {
        console.error("discord: failed to relay staff reply", err);
        await message.react("⚠️").catch(() => {});
      }
    });
    const ready = new Promise<void>((resolve) => this.client.once(Events.ClientReady, () => resolve()));
    await this.client.login(this.opts.token);
    await ready;
    // Fail fast on a wrong channel id or missing permissions.
    await this.channel();
  }

  async openThread(c: RelayConversation, firstMessage: string): Promise<string> {
    const who = c.reporterName ?? c.reporterEmail ?? "Anonymous user";
    const name = `${who}: ${firstMessage.replace(/\s+/g, " ")}`.slice(0, 95);
    const header = [
      `**From:** ${who}${c.reporterEmail && c.reporterName ? ` (${c.reporterEmail})` : ""}`,
      contextLine(c.context),
      "",
      `${LABEL.user}\n${firstMessage}`,
      "",
      "_Reply in this thread to answer them in the app. The assistant stops replying once someone from the team does._",
    ]
      .filter((l) => l !== null)
      .join("\n");
    const [first, ...rest] = chunk(header);

    const channel = await this.channel();
    let thread: ThreadChannel;
    if (channel.type === ChannelType.GuildForum) {
      thread = await (channel as ForumChannel).threads.create({
        name,
        message: { content: first, allowedMentions: { parse: [] } },
      });
    } else {
      const starter = await (channel as TextChannel).send({ content: first, allowedMentions: { parse: [] } });
      thread = await starter.startThread({ name });
    }
    for (const part of rest) await thread.send({ content: part, allowedMentions: { parse: [] } });
    return thread.id;
  }

  async post(threadId: string, author: "user" | "agent" | "system", body: string): Promise<void> {
    const thread = await this.thread(threadId);
    for (const part of chunk(`${LABEL[author]}\n${body}`)) {
      await thread.send({ content: part, allowedMentions: { parse: [] } });
    }
  }

  async requestHuman(threadId: string, reason: string): Promise<void> {
    const thread = await this.thread(threadId);
    const mention = this.opts.handoffMention ? `${this.opts.handoffMention} ` : "";
    await thread.send({
      content: `${mention}🙋 **Needs a person:** ${reason}`.slice(0, LIMIT),
      allowedMentions: { parse: ["roles", "users", "everyone"] },
    });
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
    const ch = await this.client.channels.fetch(id);
    if (!ch?.isThread()) throw new Error(`Discord thread ${id} not found`);
    if (ch.archived) await ch.setArchived(false).catch(() => {});
    return ch;
  }
}

function contextLine(ctx: Record<string, unknown> | null): string | null {
  if (!ctx) return null;
  const parts = Object.entries(ctx)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`);
  const errors = Array.isArray(ctx.errors) ? ctx.errors.length : 0;
  if (errors) parts.push(`recent errors: ${errors}`);
  return parts.length ? `**Context:** ${parts.join(" · ")}` : null;
}

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
