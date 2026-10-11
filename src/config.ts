import { z } from "zod";

const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []));

const schema = z.object({
  PORT: z.coerce.number().default(4318),
  DATABASE_PATH: z.string().default("./data/wicket.db"),
  /** Origins allowed to embed the widget, comma separated. Empty allows any origin. */
  ALLOWED_ORIGINS: csv,

  /** Serve a test page with the widget at /. On by default outside production. */
  PLAYGROUND: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v ? v === "true" : process.env.NODE_ENV !== "production")),
  PRODUCT_NAME: z.string().default("our product"),
  PRODUCT_DESCRIPTION: z.string().default(""),

  // Agent: set one key. The Vercel AI Gateway takes precedence when both are set.
  AI_GATEWAY_API_KEY: z.string().optional(),
  AI_GATEWAY_URL: z.string().default("https://ai-gateway.vercel.sh"),
  ANTHROPIC_API_KEY: z.string().optional(),
  AGENT_MODEL: z.string().default("claude-haiku-5-5"), // gateway ids get an "anthropic/" prefix if missing
  AGENT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  AGENT_MAX_STEPS: z.coerce.number().default(6),

  // Knowledge: a markdown docs repo on GitHub (GitBook Git Sync, Docusaurus, Mintlify, ...)
  DOCS_GITHUB_REPO: z.string().optional(), // "owner/repo"
  DOCS_GITHUB_REF: z.string().default("HEAD"),
  DOCS_GITHUB_TOKEN: z.string().optional(),
  DOCS_BASE_URL: z.string().optional(), // public docs site, e.g. https://docs.example.com
  DOCS_REINDEX_HOURS: z.coerce.number().default(24),

  // Relay: where conversations show up for the team
  RELAY: z.enum(["none", "discord"]).default("none"),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(), // set this and the channels below are created and found on boot
  DISCORD_TEAM_ROLE: z.string().default("Team"),
  DISCORD_CHANNEL_ID: z.string().optional(), // forum channel (preferred) or text channel
  DISCORD_HANDOFF_MENTION: z.string().default(""), // e.g. "<@&roleId>" or "@here"
  DISCORD_COMMUNITY_HELP_CHANNEL_ID: z.string().optional(), // public forum the assistant answers in

  // Abuse limits
  MAX_MESSAGES_PER_CONVERSATION_PER_HOUR: z.coerce.number().default(30),
  MAX_CONVERSATIONS_PER_IP_PER_HOUR: z.coerce.number().default(10),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = schema.parse(env);
  if (config.RELAY === "discord" && (!config.DISCORD_BOT_TOKEN || !(config.DISCORD_GUILD_ID || config.DISCORD_CHANNEL_ID))) {
    throw new Error("RELAY=discord needs DISCORD_BOT_TOKEN and either DISCORD_GUILD_ID or DISCORD_CHANNEL_ID");
  }
  return config;
}
