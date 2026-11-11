import { z } from "zod";

/**
 * What the person did just before a bug report, as the widget recorded it in the host page: pages,
 * button and link clicks (by label), console errors and the app's own breadcrumbs. It only reaches
 * the server with a report, goes to the model and onto the ticket, and is never stored anywhere else.
 */

/** At most this many steps, from the last 10 minutes, each label up to 80 characters. */
export const TRAIL_MAX = 20;
const TRAIL_MAX_AGO_S = 10 * 60;
const LABEL_MAX = 80;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The widget's trail as it arrives, before it's trimmed and scrubbed. */
export const trailBody = z
  .array(
    z.object({
      ago: z.number().finite().min(0),
      type: z.enum(["page", "click", "error", "note"]),
      label: z.string().max(2000),
    }),
  )
  .max(100);
export type TrailStep = z.infer<typeof trailBody>[number];

/** Drops card numbers, tokens and passwords written as key=value (and, with `emails`, email addresses). */
export function scrubText(v: string, opts: { emails?: boolean } = {}): string {
  const out = v
    // Not next to a letter, digit, "_" or "-", so IDs like UUIDs that end in digits stay whole.
    .replace(/(?<![\w-])(?:\d[ -]?){13,19}(?![\w-])/g, "[redacted-number]")
    .replace(/\b(bearer|token|password|secret|api[_-]?key)\b\s*[:=]\s*\S+/gi, "$1=[redacted]");
  return opts.emails ? out.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[redacted-email]") : out;
}

/** The newest steps, scrubbed, with long labels cut and old or empty ones dropped. */
export function cleanTrail(steps: TrailStep[]): TrailStep[] {
  return steps
    .filter((s) => s.ago <= TRAIL_MAX_AGO_S)
    .slice(-TRAIL_MAX)
    .map((s) => {
      // Also bearer tokens, JWTs and other long random strings, wherever they appear (UUIDs stay: they name rooms).
      let label = scrubText(s.label.replace(/\s+/g, " ").trim(), { emails: true })
        .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
        .replace(/\beyJ[\w-]+\.[\w-]+(?:\.[\w-]*)?/g, "[redacted-token]")
        .replace(/(?<![\w-])(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{32,}(?![\w-])/g, (m) => (UUID.test(m) ? m : "[redacted-token]"));
      if (label.length > LABEL_MAX) label = `${label.slice(0, LABEL_MAX - 1)}…`;
      return { ago: Math.round(s.ago), type: s.type, label };
    })
    .filter((s) => s.label);
}

/** One line per step, oldest first, timed relative to the report: `- 1m 05s before: clicked "Pause game"`. */
export function formatTrail(steps: TrailStep[]): string {
  return steps
    .map((s) => {
      const when = s.ago < 60 ? `${s.ago}s` : `${Math.floor(s.ago / 60)}m ${String(s.ago % 60).padStart(2, "0")}s`;
      const what = s.type === "page" ? `opened ${s.label}` : s.type === "click" ? `clicked "${s.label}"` : s.type === "error" ? `error: ${s.label}` : s.label;
      return `- ${when} before: ${what}`;
    })
    .join("\n");
}
