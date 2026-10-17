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
  /** Serve the Wicket marketing site at /, and move the playground (if on) to /playground. */
  SITE: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  PRODUCT_NAME: z.string().default("our product"),
  PRODUCT_DESCRIPTION: z.string().default(""),

  // Agent: set one key. The Vercel AI Gateway takes precedence when both are set.
  AI_GATEWAY_API_KEY: z.string().optional(),
  AI_GATEWAY_URL: z.string().optional(), // the AI SDK Gateway provider's base URL; defaults to Vercel's
  ANTHROPIC_API_KEY: z.string().optional(),
  AGENT_MODEL: z.string().default("claude-haiku-5-5"), // gateway ids get an "anthropic/" prefix if missing
  AGENT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("low"),
  AGENT_MAX_STEPS: z.coerce.number().default(6),
  /** Steps for profiles with app tools, which often need several queries per answer. */
  AGENT_MAX_STEPS_WITH_APP_TOOLS: z.coerce.number().default(20),

  // Knowledge: a markdown docs repo on GitHub (GitBook Git Sync, Docusaurus, Mintlify, ...)
  DOCS_GITHUB_REPO: z.string().optional(), // "owner/repo"
  DOCS_GITHUB_REF: z.string().default("HEAD"),
  DOCS_GITHUB_TOKEN: z.string().optional(),
  DOCS_BASE_URL: z.string().optional(), // public docs site, e.g. https://docs.example.com
  // Or, with no repo: a hosted docs site, read from its sitemap or by following links
  DOCS_URL: z.string().url().optional(), // docs home page (pages under its path) or a sitemap.xml
  DOCS_REINDEX_HOURS: z.coerce.number().default(24),

  // Relay: where conversations show up for the team
  RELAY: z.enum(["none", "discord"]).default("none"),
  DISCORD_BOT_TOKEN: z.string().optional(),
  DISCORD_GUILD_ID: z.string().optional(), // set this and the channels below are created and found on boot
  DISCORD_TEAM_ROLE: z.string().default("Team"),
  DISCORD_CHANNEL_ID: z.string().optional(), // forum channel (preferred) or text channel
  DISCORD_HANDOFF_MENTION: z.string().default(""), // e.g. "<@&roleId>" or "@here"
  DISCORD_COMMUNITY_HELP_CHANNEL_ID: z.string().optional(), // public forum the assistant answers in
  DISCORD_VOICE_HUB_CHANNEL_ID: z.string().optional(), // "join to create" voice channel
  DISCORD_SUPPORT_VOICE_HUB_CHANNEL_ID: z.string().optional(), // same, private to the caller and the team
  DISCORD_TEAM_ROLE_ID: z.string().optional(), // who sees and is pinged in support calls

  // Tickets: tag the bot in Discord ("@Wicket file this as a bug") to file one. Set up one tracker.
  LINEAR_API_KEY: z.string().optional(), // personal API key: Linear > Settings > Security & access
  LINEAR_TEAM_KEY: z.string().optional(), // e.g. "ED"
  LINEAR_SOURCE_LABEL: z.string().default("Source: Discord"), // added when the label exists
  GITHUB_ISSUES_REPO: z.string().optional(), // "owner/repo"
  GITHUB_ISSUES_TOKEN: z.string().optional(), // fine-grained token with Issues: read and write
  GITHUB_ISSUES_LABEL: z.string().optional(), // added to each issue when the label exists, e.g. "triage"

  // Team dashboard at /admin, with Discord sign-in. Create an OAuth2 app (the bot's own app works)
  // and add <PUBLIC_URL>/admin/auth/callback as a redirect.
  DISCORD_CLIENT_ID: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  PUBLIC_URL: z.string().optional(), // e.g. https://wicket.example.com; defaults to the request's own origin
  /** Discord user ids allowed into the dashboard, besides everyone with the team role. */
  TEAM_DISCORD_IDS: csv,
  /** Local development only: a one-click sign-in with no Discord. Never set this on a public server. */
  TEAM_DEV_LOGIN: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),

  // Email through Resend (free tier is enough): unread team replies go to the user. Needs PUBLIC_URL for links.
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(), // e.g. "Escape Director <support@escapedirector.com>", on a domain verified in Resend
  /** A domain that receives email in Resend. Replies to the email then land in the conversation. */
  EMAIL_REPLY_DOMAIN: z.string().optional(),
  /** Signing secret (whsec_...) of the Resend webhook that points at /email/inbound. */
  RESEND_WEBHOOK_SECRET: z.string().optional(),

  // Signed-in users: the host app's backend signs a short-lived HS256 JWT with this secret
  // (claims: sub, name, email, plan). Only a valid token counts as signed in.
  IDENTITY_SECRET: z.string().min(32, "IDENTITY_SECRET should be at least 32 characters").optional(),
  // Bot check for visitors (profiles with botCheck: true): a Cloudflare Turnstile widget's keys.
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  // Profiles, rules and budgets: a YAML file path, or the YAML itself. Defaults to config/wicket.yaml.
  WICKET_CONFIG: z.string().optional(),

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
  if (config.LINEAR_API_KEY && !config.LINEAR_TEAM_KEY) throw new Error("LINEAR_API_KEY needs LINEAR_TEAM_KEY (e.g. ED)");
  if (Boolean(config.GITHUB_ISSUES_REPO) !== Boolean(config.GITHUB_ISSUES_TOKEN)) throw new Error("GITHUB_ISSUES_REPO and GITHUB_ISSUES_TOKEN go together");
  if (config.LINEAR_API_KEY && config.GITHUB_ISSUES_REPO) throw new Error("Set up one tracker: Linear (LINEAR_API_KEY) or GitHub (GITHUB_ISSUES_REPO), not both");
  return config;
}
