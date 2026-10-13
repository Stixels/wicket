import fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * How the assistant behaves, per profile, and which profile applies to whom and where.
 * Loaded from a YAML (or JSON) file; secrets and infrastructure stay in environment variables.
 */

const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);

const profileSchema = z
  .object({
    /** false: no assistant. Messages go straight to the team. */
    ai: z.boolean().default(true),
    /** Extra instructions added to the assistant's system prompt. */
    instructions: z.string().optional(),
    /** Subjects the assistant may help with besides the product, e.g. "escape room operations in general". */
    topics: z.string().optional(),
    /** decline: the assistant turns down anything unrelated to the product (default). allow: it helps with anything. */
    offTopic: z.enum(["decline", "allow"]).default("decline"),
    model: z.string().optional(),
    effort: effort.optional(),
    /** Dollars per person per calendar month (UTC). Leave out for no limit. */
    budget: z.number().min(0).optional(),
    /** After the first message, offer an email field so the team can follow up. */
    askEmail: z.boolean().default(false),
    // What the widget shows. Options passed to Wicket.init() win over these.
    title: z.string().optional(),
    /** Name under the assistant's messages. */
    assistantName: z.string().optional(),
    subtitle: z.string().optional(),
    welcomeTitle: z.string().optional(),
    welcomeSubtitle: z.string().optional(),
    placeholder: z.string().optional(),
    suggestions: z.array(z.string()).optional(),
  })
  .strict();

const oneOrMany = z.union([z.string(), z.array(z.string())]).transform((v) => (Array.isArray(v) ? v : [v]));

const ruleSchema = z
  .object({
    when: z
      .object({
        /** Signed in means a valid signed user token, not just a name passed to the widget. */
        signedIn: z.boolean().optional(),
        /** The `plan` claim in the signed user token. */
        plan: oneOrMany.optional(),
        /** Page paths. "/app/analytics" also matches pages below it; "*" matches anything. */
        page: oneOrMany.optional(),
      })
      .strict()
      .default({}),
    profile: z.string(),
  })
  .strict();

/** US dollars per million tokens. */
const priceSchema = z
  .object({
    input: z.number().min(0),
    output: z.number().min(0),
    cacheRead: z.number().min(0).optional(),
    cacheWrite: z.number().min(0).optional(),
  })
  .strict();

/** The widget's look, same fields as Wicket.init({ theme }). Options passed to init() win. */
const themeSchema = z
  .object({
    accentColor: z.string().optional(),
    mode: z.enum(["auto", "light", "dark"]).optional(),
    radius: z.number().min(0).optional(),
    fontFamily: z.string().optional(),
    position: z.enum(["left", "right"]).optional(),
    cssVars: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/** A GitHub repo to search besides the main docs, e.g. an SDK with examples. */
const repoKnowledgeSchema = z
  .object({
    github: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "use owner/repo"),
    ref: z.string().optional(),
    /** Public site for the markdown pages. Without it, links go to the files on GitHub. */
    baseUrl: z.string().url().optional(),
    /** Globs of files to index. Markdown only when left out. Code files are indexed whole. */
    include: z.array(z.string()).optional(),
    exclude: z.array(z.string()).optional(),
  })
  .strict();

/** A hosted docs site with no repo: pages come from its sitemap, or by following links. */
const siteKnowledgeSchema = z
  .object({
    url: z.string().url(),
    maxPages: z.number().int().positive().optional(),
  })
  .strict();

const knowledgeSchema = z.union([repoKnowledgeSchema, siteKnowledgeSchema]);

const settingsSchema = z
  .object({
    theme: themeSchema.default({}),
    team: z
      .object({
        /** Shown when a chat goes to the team, e.g. "a few hours" -> "They usually reply within a few hours." */
        replyTime: z.string().optional(),
      })
      .strict()
      .default({}),
    files: z
      .object({
        /** Days to keep attachments before their bytes are removed. 0 keeps them forever. */
        keepDays: z.number().int().min(0).default(90),
      })
      .strict()
      .default({ keepDays: 90 }),
    /** Extra repos or sites to search. The main docs come from DOCS_GITHUB_REPO or DOCS_URL. */
    knowledge: z.array(knowledgeSchema).default([]),
    profiles: z.record(z.string(), profileSchema).default({}),
    rules: z.array(ruleSchema).default([]),
    budgets: z
      .object({
        /** Tell people when they've used this share of their budget. */
        warnAt: z.number().min(0).max(1).default(0.8),
        /** Dollars per calendar month across everyone. When reached, every chat goes to the team. */
        monthlyTotal: z.number().min(0).optional(),
        /** Overrides and additions to the built-in price list, keyed by model id. */
        prices: z.record(z.string(), priceSchema).default({}),
      })
      .strict()
      .default({ warnAt: 0.8, prices: {} }),
  })
  .strict();

export type Profile = z.infer<typeof profileSchema> & { name: string };
export type Settings = z.infer<typeof settingsSchema>;
export type Price = z.infer<typeof priceSchema>;

export interface Who {
  signedIn: boolean;
  plan: string | null;
  /** Path of the page the person is on, e.g. "/app/analytics". */
  path: string | null;
}

export const DEFAULT_PROFILE = "default";

/**
 * Reads settings from WICKET_CONFIG (a file path, or the YAML itself), else config/wicket.yaml
 * when it exists. With nothing configured, everyone gets one "default" profile with the assistant on.
 */
export function loadSettings(source = process.env.WICKET_CONFIG, fallbackPath = "config/wicket.yaml"): Settings {
  let text: string | null = null;
  let where = "";
  if (source && fs.existsSync(source)) {
    text = fs.readFileSync(source, "utf8");
    where = source;
  } else if (source && /[\n:{]/.test(source)) {
    text = source;
    where = "WICKET_CONFIG";
  } else if (source) {
    throw new Error(`WICKET_CONFIG points at ${source}, which doesn't exist`);
  } else if (fs.existsSync(fallbackPath)) {
    text = fs.readFileSync(fallbackPath, "utf8");
    where = fallbackPath;
  }
  return parseSettings(text ?? "", where || "defaults");
}

export function parseSettings(text: string, where = "settings"): Settings {
  const raw = text.trim() ? parseYaml(text) : {};
  // A key whose options are all commented out parses as null; treat it as empty.
  const tidy = (o: unknown) => (o && typeof o === "object" && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)) : o);
  const top = tidy(raw ?? {}) as Record<string, unknown>;
  if (top.profiles && typeof top.profiles === "object") {
    top.profiles = Object.fromEntries(Object.entries(top.profiles).map(([k, v]) => [k, v ?? {}]));
  }
  const parsed = settingsSchema.safeParse(top);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(top)"}: ${i.message}`).join("\n");
    throw new Error(`Invalid Wicket settings in ${where}:\n${issues}`);
  }
  const settings = parsed.data;
  for (const rule of settings.rules) {
    if (!settings.profiles[rule.profile] && rule.profile !== DEFAULT_PROFILE) {
      throw new Error(`Invalid Wicket settings in ${where}: rule points at profile "${rule.profile}", which isn't defined`);
    }
  }
  return settings;
}

/** The first rule that matches picks the profile; otherwise "default". */
export function resolveProfile(settings: Settings, who: Who): Profile {
  const rule = settings.rules.find((r) => matches(r.when, who));
  const name = rule?.profile ?? DEFAULT_PROFILE;
  return { ...profileSchema.parse(settings.profiles[name] ?? {}), name };
}

function matches(when: z.infer<typeof ruleSchema>["when"], who: Who): boolean {
  if (when.signedIn !== undefined && when.signedIn !== who.signedIn) return false;
  if (when.plan && !(who.plan && when.plan.includes(who.plan))) return false;
  if (when.page && !(who.path !== null && when.page.some((p) => pathMatches(p, who.path!)))) return false;
  return true;
}

/** "/app/analytics" matches itself and anything below it; "*" is a wildcard. */
export function pathMatches(pattern: string, path: string): boolean {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const pat = norm(pattern.trim());
  const target = norm(path);
  if (pat.includes("*")) {
    const re = new RegExp(`^${pat.split("*").map(escapeRegex).join(".*")}$`);
    return re.test(target);
  }
  return target === pat || target.startsWith(pat === "/" ? "/" : `${pat}/`);
}

/** The page path from widget context: an explicit `path`, or the pathname of `page` (a URL). */
export function pathFromContext(context: Record<string, unknown> | null | undefined): string | null {
  if (!context) return null;
  if (typeof context.path === "string" && context.path.startsWith("/")) return context.path;
  if (typeof context.page === "string") {
    try {
      return new URL(context.page, "http://x").pathname;
    } catch {
      return null;
    }
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
