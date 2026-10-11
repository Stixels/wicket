/**
 * Runs the Discord server setup by hand. You don't normally need this: the service runs
 * the same setup on boot when DISCORD_GUILD_ID is set.
 *
 *   DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... npm run discord:setup
 */
import { setupGuild } from "../src/discord/setup.js";

const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
if (!token || !guildId) {
  console.error("Set DISCORD_BOT_TOKEN and DISCORD_GUILD_ID");
  process.exit(1);
}

const result = await setupGuild(token, guildId, process.env.DISCORD_TEAM_ROLE);
console.log(result.created.length ? `Created: ${result.created.join(", ")}` : "Everything already existed.");
console.log(`\nsupport inbox ${result.supportInboxId}, help ${result.helpId}, team role ${result.teamRoleId}`);
if (!result.hasCommunity) {
  console.log("Tip: turn on Community in Server Settings to get a real announcement channel and a welcome screen.");
}
