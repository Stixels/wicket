import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import type { Tracker } from "./adapters/types.js";
import { parseSettings, type Settings } from "./settings.js";
import { DemoTracker } from "./demo/tracker.js";
import { LinearTracker } from "./adapters/tracker/linear.js";
import { GitHubIssuesTracker } from "./adapters/tracker/github.js";

export type DemoSettings = NonNullable<Settings["demo"]>;

/** The public demo's settings when DEMO=true, else null. A settings file's demo section alone doesn't turn it on. */
export function demoSettings(config: Config, settings: Settings): DemoSettings | null {
  return config.DEMO ? (settings.demo ?? parseSettings("demo: {}").demo!) : null;
}

/**
 * Where tickets go. The demo always gets its own tracker, even if a real one were configured
 * (loadConfig refuses that anyway), so nothing that boots in demo mode can reach a real one.
 */
export function createTracker(config: Config, db: Db, demo: DemoSettings | null): (Tracker & { check(): Promise<string> }) | null {
  if (demo) return new DemoTracker(db, { advanceMs: demo.advanceMinutes * 60_000, backlog: demo.backlog });
  if (config.LINEAR_API_KEY) return new LinearTracker({ apiKey: config.LINEAR_API_KEY, teamKey: config.LINEAR_TEAM_KEY!, sourceLabel: config.LINEAR_SOURCE_LABEL });
  if (config.GITHUB_ISSUES_REPO) return new GitHubIssuesTracker({ token: config.GITHUB_ISSUES_TOKEN!, repo: config.GITHUB_ISSUES_REPO, sourceLabel: config.GITHUB_ISSUES_LABEL });
  return null;
}
