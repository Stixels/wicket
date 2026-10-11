import { z } from "zod";

const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []));

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_PATH: z.string().default("./data/wicket.db"),
  /** Origins allowed to embed the widget, comma separated. Empty allows any origin. */
  ALLOWED_ORIGINS: csv,

  PRODUCT_NAME: z.string().default("our product"),
  PRODUCT_DESCRIPTION: z.string().default(""),

  // Agent
  AGENT_MODEL: z.string().default("claude-opus-5-5"),
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
  if (config.RELAY === "discord" && (!config.DISCORD_BOT_TOKEN || !config.DISCORD_CHANNEL_ID)) {
    throw new Error("RELAY=discord needs DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID");
  }
  return config;
}
