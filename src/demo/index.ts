import { signUserToken } from "../identity.js";
import type { Settings } from "../settings.js";
import { priceFor } from "../usage.js";
import type { TicketNotice } from "../tickets.js";

/** The one person the demo signs in. Each browser gets its own id, so nobody sees anyone else's chats. */
export const DEMO_USER = { name: "Sam", role: "Owner", venue: "Treehouse Escapes" } as const;

/** Short-lived: the widget asks for a fresh one with every message. */
export const DEMO_TOKEN_TTL_SECONDS = 600;

/** For MCP clients, whose config holds the token: a day, the longest a user token may last. */
export const DEMO_MCP_TOKEN_TTL_SECONDS = 24 * 3600 - 60;

/** A browser's demo id, from its cookie. Random and unguessable, so it's safe to key a person's chats on. */
export const DEMO_VISITOR_ID = /^[A-Za-z0-9_-]{22,64}$/;

/** Signs the demo's fake customer for one browser. Nothing else can be signed this way. */
export function demoUserToken(visitorId: string, secret: string, now = Date.now(), ttlSeconds = DEMO_TOKEN_TTL_SECONDS): string {
  if (!DEMO_VISITOR_ID.test(visitorId)) throw new Error("bad demo visitor id");
  return signUserToken({ sub: `demo-${visitorId}`, name: DEMO_USER.name }, secret, Math.min(ttlSeconds, DEMO_MCP_TOKEN_TTL_SECONDS), now);
}

/** Output price, in dollars per million tokens, that DEMO_ANSWER_RESERVE_MICROS is sized for (Claude Haiku 5.5). */
const DEMO_MAX_OUTPUT_PRICE = 0.5;

/** Settings that would reach a real system from the public demo, or let it spend past its cap. */
export function demoSettingsProblems(settings: Settings, agentModel: string): string[] {
  const problems: string[] = [];
  for (const [name, p] of Object.entries(settings.profiles)) {
    if (p.appTools) problems.push(`profile ${name} has appTools, which would call a real app's API`);
  }
  for (const m of new Set([agentModel, ...Object.values(settings.profiles).flatMap((p) => (p.model ? [p.model] : []))])) {
    const price = priceFor(m, settings.budgets.prices);
    if (!price || price.output > DEMO_MAX_OUTPUT_PRICE) problems.push(`model ${m} costs more than the demo's per-answer reserve allows; use claude-haiku-5-5`);
  }
  if (settings.announcements.feed) problems.push("announcements.feed posts to Discord");
  if (settings.assistant.helpForum) problems.push("assistant.helpForum answers in Discord");
  return problems;
}

/** What the simulated team says after a demo ticket moves on. */
export function demoTeamReply(n: TicketNotice): string | null {
  const note = "\n\n(Simulated reply. In a real install, this is your team writing from Discord or the dashboard.)";
  if (n.stage === "done") return `Fixed in today's update. Thanks for the clear report, Sam! Let us know if you still see it.${note}`;
  if (n.stage === "planned") return `We're adding this to the roadmap. Thanks for the idea, it's a good one.${note}`;
  return null;
}
