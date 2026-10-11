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

const result = await setupGuild(token, guildId, {
  teamRoleName: process.env.DISCORD_TEAM_ROLE,
  productName: process.env.PRODUCT_NAME,
  docsUrl: process.env.DOCS_BASE_URL,
});
console.log(result.created.length ? `Changed: ${result.created.join(", ")}` : "Everything was already set up.");
console.log(`\nsupport inbox ${result.supportInboxId}, help ${result.helpId}, team role ${result.teamRoleId}`);
for (const step of result.manual) console.log(`Needs you: ${step}`);
