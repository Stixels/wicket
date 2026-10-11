import { ChannelType, Events, type Client, type VoiceBasedChannel, type VoiceChannel } from "discord.js";

/** Rooms are named with this prefix so leftovers can be found and cleaned up after a restart. */
const ROOM_PREFIX = "🔊 ";

/**
 * Join-to-create voice: joining the hub channel creates a room next to it and moves you in.
 * The room is deleted once the last person leaves. The bot needs Manage Channels and Move Members,
 * and the client needs the GuildVoiceStates intent.
 */
export function attachVoiceRooms(client: Client, hubChannelId: string) {
  const isRoom = (c: VoiceBasedChannel, hub: VoiceBasedChannel) =>
    c.id !== hub.id && c.type === ChannelType.GuildVoice && c.parentId === hub.parentId && c.name.startsWith(ROOM_PREFIX);

  client.on(Events.VoiceStateUpdate, async (before, after) => {
    try {
      if (after.channelId === hubChannelId && after.member && after.channel) {
        const hub = after.channel;
        const room: VoiceChannel = await hub.guild.channels.create({
          name: `${ROOM_PREFIX}${after.member.displayName}`.slice(0, 100),
          type: ChannelType.GuildVoice,
          parent: hub.parentId ?? undefined,
          reason: "Join-to-create voice room",
        });
        await after.member.voice.setChannel(room).catch(async (err) => {
          // They left before the move finished, or the bot can't move members.
          await room.delete().catch(() => {});
          throw err;
        });
      }
      const left = before.channel;
      if (left && left.id !== after.channelId && left.members.size === 0) {
        const hub = await client.channels.fetch(hubChannelId);
        if (hub?.isVoiceBased() && isRoom(left, hub)) await left.delete("Voice room is empty");
      }
    } catch (err) {
      console.error("discord: voice room error", err);
    }
  });

  // Clean up rooms left empty while the bot was offline.
  client.once(Events.ClientReady, async () => {
    const hub = await client.channels.fetch(hubChannelId).catch(() => null);
    if (!hub?.isVoiceBased()) return console.error(`discord: voice hub ${hubChannelId} not found`);
    for (const c of hub.guild.channels.cache.values()) {
      if (c.isVoiceBased() && isRoom(c, hub) && c.members.size === 0) await c.delete("Voice room is empty").catch(() => {});
    }
  });
}
