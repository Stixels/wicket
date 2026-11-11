/**
 * A short rolling record of what the person did in the host page just before a report: page changes,
 * clicks on buttons and links (by their visible label, never what anyone typed), console errors, and
 * breadcrumbs the app adds with Wicket.addBreadcrumb(). It stays in the page and is only sent with a report.
 */

export type TrailType = "page" | "click" | "error" | "note";

/** One step as sent: seconds before the report, what kind of step, and a short label. */
export interface TrailStep {
  ago: number;
  type: TrailType;
  label: string;
}

/** The last 20 steps from the last 5 minutes, labels up to 80 characters. */
export const TRAIL_MAX = 20;
export const TRAIL_WINDOW_MS = 5 * 60 * 1000;
export const LABEL_MAX = 80;

export class Trail {
  private steps: { at: number; type: TrailType; label: string }[] = [];
  enabled = true;

  constructor(private now: () => number = Date.now) {}

  add(type: TrailType, label: string) {
    const text = clean(label);
    if (!this.enabled || !text) return;
    const at = this.now();
    const last = this.steps.at(-1);
    // A page reported twice in a row (pushState then popstate, say) is one step.
    if (last && last.type === type && last.label === text && type === "page") return;
    this.steps.push({ at, type, label: text });
    this.prune(at);
  }

  /** Stops recording and forgets what was recorded. */
  disable() {
    this.enabled = false;
    this.steps = [];
  }

  /** The steps up to `at` (default now), oldest first, each as seconds before it. */
  snapshot(at = this.now()): TrailStep[] {
    this.prune(this.now());
    return this.steps.filter((s) => s.at <= at && at - s.at <= TRAIL_WINDOW_MS).map((s) => ({ ago: Math.round((at - s.at) / 1000), type: s.type, label: s.label }));
  }

  private prune(now: number) {
    this.steps = this.steps.filter((s) => now - s.at <= TRAIL_WINDOW_MS).slice(-TRAIL_MAX);
  }
}

function clean(label: string): string {
  const text = String(label ?? "").replace(/\s+/g, " ").trim();
  return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX - 1)}…` : text;
}

/** The parts of a DOM element the click label needs, so it can be tested without a browser. */
export interface ElementLike {
  tagName: string;
  getAttribute(name: string): string | null;
  textContent: string | null;
  parentElement: ElementLike | null;
}

const CLICKABLE = new Set(["A", "BUTTON", "SUMMARY"]);
const BUTTON_INPUTS = new Set(["button", "submit", "reset"]);
const ROLES = new Set(["button", "link", "menuitem", "tab", "option", "checkbox", "switch"]);

/**
 * What a click was on, as the person would name it: the aria-label or visible text of the nearest
 * button or link. Clicks on anything else (text fields, plain text) aren't recorded, and the value of
 * an input is never read, only the label of a button-type input.
 */
export function clickLabel(target: ElementLike | null): string | null {
  for (let el = target, depth = 0; el && depth < 6; el = el.parentElement, depth++) {
    const tag = el.tagName.toUpperCase();
    const role = el.getAttribute("role");
    const input = tag === "INPUT" && BUTTON_INPUTS.has((el.getAttribute("type") ?? "").toLowerCase());
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.getAttribute("contenteditable") != null) {
      if (!input) return null;
    }
    if (!CLICKABLE.has(tag) && !input && !(role && ROLES.has(role))) continue;
    const label = el.getAttribute("aria-label") || el.getAttribute("title") || (input ? el.getAttribute("value") : el.textContent) || "";
    const text = clean(label);
    return text || null;
  }
  return null;
}

/** A page as a step: the path and hash route, never the query string (it can hold tokens). */
export function pageLabel(loc: { pathname: string; hash: string }): string {
  return `${loc.pathname}${loc.hash.startsWith("#/") ? loc.hash.split("?")[0] : ""}`;
}
