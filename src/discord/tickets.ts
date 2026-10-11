import { EmbedBuilder, Events, type Client, type Message } from "discord.js";
import type { TicketDraft, Tracker } from "../adapters/types.js";

export interface TicketCommandOptions {
  tracker: Tracker;
  draft: (transcript: string, ask: string) => Promise<TicketDraft>;
  /** Only members with this role can file tickets. */
  teamRoleId?: string;
}

const KIND_LABEL = { bug: "🐛 Bug", feature: "✨ Feature", improvement: "🔧 Improvement", docs: "📚 Docs", question: "❓ Question" } as const;

/** True when a message tags the bot (directly, not through @everyone or a role). */
export function mentionsBot(message: Message): boolean {
  const me = message.client.user?.id;
  return Boolean(me && message.mentions.users.has(me) && !message.mentions.everyone);
}

/**
 * "@Wicket file this as a bug": a teammate tags the bot anywhere in the server, and it
 * drafts a ticket from the surrounding conversation, files it and replies with the link.
 */
export function attachTicketCommand(client: Client, opts: TicketCommandOptions) {
  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.inGuild() || !mentionsBot(message)) return;
    if (opts.teamRoleId && !message.member?.roles.cache.has(opts.teamRoleId)) {
      await message.reply({ content: "Only the team can file tickets.", allowedMentions: { repliedUser: false } }).catch(() => {});
      return;
    }
    const typing = setInterval(() => void message.channel.sendTyping().catch(() => {}), 8000);
    void message.channel.sendTyping().catch(() => {});
    try {
      const ask = message.content.replace(/<@!?\d+>/g, "").trim();
      const transcript = await gather(message);
      const draft = await opts.draft(transcript, ask);
      const ticket = await opts.tracker.create({
        ...draft,
        description: `${draft.description}\n\n---\nFiled from Discord by ${name(message)}: ${message.url}`,
      });
      const embed = new EmbedBuilder()
        .setColor(0x5e6ad2)
        .setTitle(`${ticket.key}: ${draft.title}`.slice(0, 256))
        .setURL(ticket.url)
        .setDescription(`${KIND_LABEL[draft.kind] ?? draft.kind} · filed in ${opts.tracker.name === "linear" ? "Linear" : opts.tracker.name}`);
      await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
    } catch (err) {
      console.error("discord: ticket failed", err);
      await message.reply({ content: "⚠️ I couldn't file that ticket. Check the logs, or try again.", allowedMentions: { repliedUser: false } }).catch(() => {});
    } finally {
      clearInterval(typing);
    }
  });
}

/** The conversation around the mention as plain text, oldest first, including the bot's message cards. */
async function gather(message: Message): Promise<string> {
  const channel = message.channel;
  const lines: string[] = [];
  if (channel.isThread()) lines.push(`Thread title: ${channel.name}`);
  const limit = channel.isThread() ? 60 : 15;
  const recent = await channel.messages.fetch({ limit, before: message.id }).catch(() => null);
  const history = recent ? [...recent.values()].reverse() : [];
  if (channel.isThread()) {
    const starter = await channel.fetchStarterMessage().catch(() => null);
    if (starter && !history.some((m) => m.id === starter.id)) history.unshift(starter);
  }
  if (message.reference?.messageId) {
    const ref = await message.fetchReference().catch(() => null);
    if (ref && !history.some((m) => m.id === ref.id)) history.push(ref);
  }
  for (const m of history) {
    const text = render(m);
    if (text) lines.push(text);
  }
  return lines.join("\n").slice(-30_000);
}

function render(m: Message): string {
  const parts = [m.content.trim()];
  for (const e of m.embeds) {
    const who = e.author?.name ?? e.title;
    const fields = e.fields.map((f) => `${f.name}: ${f.value}`).join(", ");
    parts.push([who && `[${who}]`, e.description, fields].filter(Boolean).join(" "));
  }
  for (const a of m.attachments.values()) parts.push(`(attachment: ${a.url})`);
  const body = parts.filter(Boolean).join("\n");
  return body ? `${name(m)}: ${body}` : "";
}

function name(m: Message) {
  return m.member?.displayName ?? m.author.globalName ?? m.author.username;
}
