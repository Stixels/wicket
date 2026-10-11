import {
  ChannelType,
  Events,
  PermissionFlagsBits as P,
  type Client,
  type VoiceBasedChannel,
  type VoiceChannel,
} from "discord.js";

export interface VoiceHub {
  channelId: string;
  /** Room names start with this, so leftovers can be found and cleaned up after a restart. */
  prefix: string;
  /** Support hub: only the caller and this role can see the room, and the role is pinged in it. */
  teamRoleId?: string;
}

export const COMMUNITY_ROOM_PREFIX = "🔊 ";
export const SUPPORT_ROOM_PREFIX = "🎧 ";

/**
 * Join-to-create voice: joining a hub channel creates a room next to it and moves you in.
 * The room is deleted once the last person leaves. The bot needs Manage Channels and Move Members,
 * and the client needs the GuildVoiceStates intent.
 */
export function attachVoiceRooms(client: Client, hubs: VoiceHub[]) {
  const isRoom = (c: VoiceBasedChannel, hub: VoiceBasedChannel, h: VoiceHub) =>
    c.id !== hub.id && c.type === ChannelType.GuildVoice && c.parentId === hub.parentId && c.name.startsWith(h.prefix);

  client.on(Events.VoiceStateUpdate, async (before, after) => {
    try {
      const joined = hubs.find((h) => h.channelId === after.channelId);
      if (joined && after.member && after.channel) {
        const hub = after.channel;
        const member = after.member;
        const room: VoiceChannel = await hub.guild.channels.create({
          name: `${joined.prefix}${member.displayName}`.slice(0, 100),
          type: ChannelType.GuildVoice,
          parent: hub.parentId ?? undefined,
          reason: "Join-to-create voice room",
          permissionOverwrites: joined.teamRoleId
            ? [
                { id: hub.guild.roles.everyone.id, deny: [P.ViewChannel] },
                { id: joined.teamRoleId, allow: [P.ViewChannel, P.Connect, P.Speak, P.SendMessages] },
                { id: member.id, allow: [P.ViewChannel, P.Connect, P.Speak, P.SendMessages] },
                { id: client.user!.id, allow: [P.ViewChannel, P.Connect, P.SendMessages] },
              ]
            : undefined,
        });
        await member.voice.setChannel(room).catch(async (err) => {
          // They left before the move finished, or the bot can't move members.
          await room.delete().catch(() => {});
          throw err;
        });
        if (joined.teamRoleId) {
          await room.send({
            content: `<@&${joined.teamRoleId}> ${member} is waiting for help in this call.`,
            allowedMentions: { roles: [joined.teamRoleId] },
          });
        }
      }
      const left = before.channel;
      if (left && left.id !== after.channelId && left.members.size === 0) {
        for (const h of hubs) {
          const hub = await client.channels.fetch(h.channelId).catch(() => null);
          if (hub?.isVoiceBased() && isRoom(left, hub, h)) {
            await left.delete("Voice room is empty");
            break;
          }
        }
      }
    } catch (err) {
      console.error("discord: voice room error", err);
    }
  });

  // Clean up rooms left empty while the bot was offline.
  client.once(Events.ClientReady, async () => {
    for (const h of hubs) {
      const hub = await client.channels.fetch(h.channelId).catch(() => null);
      if (!hub?.isVoiceBased()) {
        console.error(`discord: voice hub ${h.channelId} not found`);
        continue;
      }
      for (const c of hub.guild.channels.cache.values()) {
        if (c.isVoiceBased() && isRoom(c, hub, h) && c.members.size === 0) await c.delete("Voice room is empty").catch(() => {});
      }
    }
  });
}
