import { Halftone } from "./halftone.js";
/**
 * Help and feedback widget. Add to any web app:
 *
 *   <script src="https://YOUR-SERVER/widget.js" defer></script>
 *   <script>
 *     window.addEventListener("load", () => Wicket.init({
 *       user: { id: "u_123", name: "Sam", email: "sam@example.com" },
 *       context: { appVersion: "1.4.2", plan: "pro" },
 *       theme: { accentColor: "#e8590c" },
 *     }));
 *   </script>
 *
 * Or set data-auto-init on the script tag to show the launcher without user info.
 */

interface User {
  id?: string;
  name?: string;
  email?: string;
}

export interface Theme {
  /** Brand color for the launcher, header accents, your messages and buttons. */
  accentColor?: string;
  /** "auto" follows the visitor's system setting. */
  mode?: "auto" | "light" | "dark";
  /** Corner radius of the panel in px; bubbles and inputs scale from it. */
  radius?: number;
  fontFamily?: string;
  position?: "right" | "left";
  /** Distance from the screen edges in px. */
  offset?: { x?: number; y?: number };
  zIndex?: number;
  /** Raw CSS variable overrides for anything else, e.g. { "--wk-bg": "#fffaf5" }. */
  cssVars?: Record<string, string>;
}

interface InitOptions {
  apiUrl?: string;
  user?: User;
  /**
   * A short-lived token your backend signs for the signed-in user (HS256 JWT with the shared
   * IDENTITY_SECRET; claims sub, name, email, plan). Pass the token, or a function that fetches one.
   * Only a valid token counts as signed in for profiles and budgets.
   */
  userToken?: string | (() => string | Promise<string>);
  context?: Record<string, unknown>;
  title?: string;
  /** Name under the assistant's messages. Defaults to "Assistant". */
  assistantName?: string;
  subtitle?: string;
  greeting?: string;
  /** Large heading on the start screen. Defaults to "Hi {first name} 👋". */
  welcomeTitle?: string;
  /** Second line of the start screen heading. */
  welcomeSubtitle?: string;
  placeholder?: string;
  /** Square image shown in the header and next to assistant messages. */
  logoUrl?: string;
  /** Text next to the launcher icon. Empty shows the icon only. */
  launcherLabel?: string;
  /** Quick starts shown before the first message. Empty array hides them. */
  suggestions?: string[];
  /** Hide the floating button and open the panel yourself with Wicket.open(). */
  hideLauncher?: boolean;
  /** Fill the page with the chat, always open: for a page that is only the chat. */
  page?: boolean;
  /** Open this conversation, e.g. from a link in an email. */
  conversation?: { id: string; token: string };
  showBranding?: boolean;
  theme?: Theme;
  /** @deprecated use theme.accentColor */
  accentColor?: string;
}

type UiKey = "title" | "assistantName" | "subtitle" | "welcomeTitle" | "welcomeSubtitle" | "placeholder" | "suggestions";
const UI_KEYS: UiKey[] = ["title", "assistantName", "subtitle", "welcomeTitle", "welcomeSubtitle", "placeholder", "suggestions"];

const DEFAULTS = {
  title: "Help & feedback",
  subtitle: "Ask, report a problem or share an idea",
  greeting: "Ask a question, report something that's not working, or share an idea.",
  welcomeSubtitle: "How can we help you today?",
  placeholder: "Write a message…",
  launcherLabel: "",
  suggestions: ["I have a question", "Something's not working", "I have an idea"],
  showBranding: true,
};

/** Defaults when the profile has no assistant and messages go straight to the team. */
const TEAM_ONLY_DEFAULTS: Partial<Record<UiKey, string>> = {
  welcomeSubtitle: "Send us a message and the team will reply here.",
  placeholder: "Message the team…",
};

/** What the server says applies to this person on this page. */
interface Session {
  profile: string;
  ai: boolean;
  signedIn: boolean;
  /** The signed-in user's name, from their token. */
  name: string | null;
  askEmail: boolean;
  theme?: Theme;
  ui: Partial<Record<UiKey, any>>;
}

interface Summary {
  id: string;
  status: string;
  title: string;
  last: { author: string; authorName: string | null; body: string; createdAt: number } | null;
  updatedAt: number;
  /** Something they reported shipped, and they haven't seen it yet. */
  news?: boolean;
  /** Where the latest thing they reported in it stands. */
  report?: TicketCard | null;
}

interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
  expired?: boolean;
}

interface Message {
  id: number;
  author: "user" | "agent" | "staff" | "system";
  authorName: string | null;
  body: string;
  attachments?: Attachment[];
  /** "logged" when something they reported was logged; "fixed" or "shipped" when it's done. */
  event?: string;
  card?: TicketCard;
  /** Set on news the user hasn't seen yet when the widget connects. */
  unseen?: boolean;
  createdAt: number;
}

/** A report's progress: "logged" when it reaches the team, "done" when it ships. */
interface TicketCard {
  type: "ticket";
  stage: "logged" | "done";
  kind: string | null;
  summary: string;
  reportedAt: number;
  doneAt?: number;
  others?: number;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/csv,application/json,video/mp4,video/quicktime,video/webm,application/zip";

const scriptEl = document.currentScript as HTMLScriptElement | null;
const scriptSrc = scriptEl?.src;

// Keep the last errors the user ran into; they're attached to new conversations.
const recentErrors: string[] = [];
function rememberError(text: string) {
  recentErrors.push(`${new Date().toISOString()} ${text}`.slice(0, 500));
  if (recentErrors.length > 20) recentErrors.shift();
}
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  try {
    rememberError(args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : safeJson(a))).join(" "));
  } catch {}
  originalConsoleError.apply(console, args as []);
};
window.addEventListener("error", (e) => rememberError(`${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => rememberError(`Unhandled rejection: ${String(e.reason?.stack || e.reason)}`));

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

const CSS = `
:host { all: initial; }
.wk {
  --wk-accent: #4f46e5;
  --wk-on-accent: #ffffff;
  --wk-radius: 20px;
  --wk-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --wk-bg: #ffffff;
  --wk-surface: #f6f6f8;
  --wk-bubble: #ffffff;
  --wk-border: rgba(15, 15, 30, 0.08);
  --wk-text: #16161d;
  --wk-muted: #6e6e7a;
  --wk-shadow: 0 1px 2px rgba(15,15,30,.06), 0 8px 24px rgba(15,15,30,.10), 0 24px 64px rgba(15,15,30,.14);
  --wk-x: 20px;
  --wk-y: 20px;
  --wk-z: 2147483000;
  font-family: var(--wk-font);
  -webkit-font-smoothing: antialiased;
  color: var(--wk-text);
}
.wk.dark {
  --wk-bg: #18181d;
  --wk-surface: #111115;
  --wk-bubble: #222229;
  --wk-border: rgba(255, 255, 255, 0.08);
  --wk-text: #ededf2;
  --wk-muted: #9a9aa6;
  --wk-shadow: 0 1px 2px rgba(0,0,0,.3), 0 8px 24px rgba(0,0,0,.35), 0 24px 64px rgba(0,0,0,.45);
}
* { box-sizing: border-box; }
button { font: inherit; color: inherit; }

/* Launcher */
.launcher {
  position: fixed; bottom: var(--wk-y); right: var(--wk-x); z-index: var(--wk-z);
  height: 56px; min-width: 56px; padding: 0 18px; border: 0; border-radius: 999px;
  background: var(--wk-accent); color: var(--wk-on-accent);
  display: inline-flex; align-items: center; justify-content: center; gap: 10px;
  font-size: 15px; font-weight: 600; letter-spacing: -0.01em; cursor: pointer;
  box-shadow: 0 6px 16px color-mix(in srgb, var(--wk-accent) 35%, transparent), 0 2px 4px rgba(0,0,0,.12);
  transition: transform .2s cubic-bezier(.2,.8,.2,1), box-shadow .2s;
}
.launcher.icon-only { padding: 0; width: 56px; }
.launcher:hover { transform: translateY(-2px); box-shadow: 0 10px 24px color-mix(in srgb, var(--wk-accent) 40%, transparent), 0 3px 6px rgba(0,0,0,.14); }
.launcher:focus-visible, .icon-btn:focus-visible, .send:focus-visible, .chip:focus-visible { outline: 3px solid color-mix(in srgb, var(--wk-accent) 45%, transparent); outline-offset: 2px; }
.launcher svg { width: 24px; height: 24px; flex: none; transition: transform .25s cubic-bezier(.2,.8,.2,1), opacity .2s; }
.launcher .ic-close { position: absolute; opacity: 0; transform: rotate(-90deg) scale(.6); }
.wk.open .launcher .ic-chat { opacity: 0; transform: rotate(90deg) scale(.6); }
.wk.open .launcher .ic-close { opacity: 1; transform: none; }
.wk.open .launcher .label { display: none; }
.wk.open .launcher { padding: 0; width: 56px; }
.badge { position: absolute; top: -2px; right: -2px; min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px;
  background: #ef4444; color: #fff; font-size: 11px; font-weight: 700; display: none; align-items: center; justify-content: center;
  border: 2px solid var(--wk-bg); }
.badge.on { display: inline-flex; }
.left .launcher { right: auto; left: var(--wk-x); }

/* Panel */
.panel {
  position: fixed; right: var(--wk-x); bottom: calc(var(--wk-y) + 72px); z-index: var(--wk-z);
  width: min(440px, calc(100vw - var(--wk-x) * 2)); height: min(760px, calc(100vh - var(--wk-y) - 100px));
  background: var(--wk-surface); border: 1px solid var(--wk-border); border-radius: var(--wk-radius);
  box-shadow: var(--wk-shadow); display: flex; flex-direction: column; overflow: hidden;
  opacity: 0; transform: translateY(12px) scale(.98); transform-origin: bottom right; pointer-events: none; visibility: hidden;
  transition: opacity .2s ease, transform .25s cubic-bezier(.2,.8,.2,1), visibility 0s linear .25s;
}
.left .panel { right: auto; left: var(--wk-x); transform-origin: bottom left; }
.wk.open .panel { opacity: 1; transform: none; pointer-events: auto; visibility: visible; transition-delay: 0s; }

/* An animated halftone pattern in the brand color behind the header, fading into the conversation. */
.glow { position: absolute; inset: 0 0 auto 0; width: 100%; height: 300px; pointer-events: none; z-index: 0;
  -webkit-mask-image: linear-gradient(180deg, #000 35%, transparent 95%);
  mask-image: linear-gradient(180deg, #000 35%, transparent 95%);
  background: linear-gradient(180deg, color-mix(in srgb, var(--wk-accent) 14%, var(--wk-surface)), var(--wk-surface)); }
.glow { transition: height .45s cubic-bezier(.2,.8,.2,1); }
/* In a conversation the pattern shrinks to a strip behind the header instead of fading away. */
.wk:not(.home) .glow { height: 112px; -webkit-mask-image: linear-gradient(180deg, #000 55%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 55%, transparent 100%); }
.wk.open .glow { animation: wk-glow-in .8s cubic-bezier(.2,.8,.2,1) both; }
@keyframes wk-glow-in { from { opacity: 0; } }

.head {
  position: relative; z-index: 1;
  padding: 18px 16px 16px 18px; display: flex; flex-direction: column; gap: 0;
  border-bottom: 1px solid transparent; transition: border-color .2s, background-color .2s;
}
.head.scrolled { border-bottom-color: var(--wk-border); background: color-mix(in srgb, var(--wk-bg) 72%, transparent);
  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); }
.log, .composer { position: relative; z-index: 1; }
.bar { display: flex; align-items: center; gap: 12px; }
.hero { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows .35s cubic-bezier(.2,.8,.2,1), opacity .25s; }
.hero > div { overflow: hidden; }
.hello { font-size: 27px; font-weight: 650; letter-spacing: -0.03em; line-height: 1.15; padding-top: 30px; }
.ask { font-size: 27px; font-weight: 650; letter-spacing: -0.03em; line-height: 1.15; color: color-mix(in srgb, var(--wk-text) 55%, transparent); padding-bottom: 6px; }
.wk.home .chips { margin-left: 0; }
.greet { margin: 12px 0 0; font-size: 14px; line-height: 1.5; color: var(--wk-muted); }
.wk.home .hero { grid-template-rows: 1fr; opacity: 1; }
.wk.home .titles { visibility: hidden; }
.wk.home .new { display: none; }
.wk.home .x { background: color-mix(in srgb, var(--wk-bg) 55%, transparent); color: var(--wk-text);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
.wk.home .head.scrolled { background: transparent; border-bottom-color: transparent; -webkit-backdrop-filter: none; backdrop-filter: none; }
.avatar { width: 36px; height: 36px; border-radius: 12px; flex: none; display: grid; place-items: center; overflow: hidden;
  background: var(--wk-accent); color: var(--wk-on-accent); }
.avatar img { width: 100%; height: 100%; object-fit: cover; }
.avatar svg { width: 20px; height: 20px; }
/* The assistant is a little orb with a face. Only the one in the header is alive: it looks around
   and blinks, and while the assistant thinks its eyes ease into three bouncing dots, the swirl speeds
   up and it glows (all faded in and out). The avatars beside messages stay still. */
.avatar, .row .mini, .typing .mini { position: relative; }
.bot { border-radius: 50% !important; isolation: isolate; font-size: 36px; overflow: visible !important; }
.row .mini.bot, .typing .mini.bot { font-size: 26px; }
.bot .orb, .bot .orb2 { position: absolute; inset: 0; z-index: -2; border-radius: 50%; overflow: hidden; }
.bot .orb::before, .bot .orb2::before { content: ""; position: absolute; inset: -35%; filter: blur(2px);
  background: conic-gradient(from 0deg, var(--wk-accent), color-mix(in srgb, var(--wk-accent) 50%, white),
    var(--wk-accent), color-mix(in srgb, var(--wk-accent) 60%, black), var(--wk-accent)); }
.bot .orb2 { opacity: 0; transition: opacity .6s ease; }
.bot::before { content: ""; position: absolute; inset: 0; z-index: -1; border-radius: 50%;
  background: radial-gradient(circle at 32% 26%, rgba(255,255,255,.55), transparent 48%); }
.bot .eyes { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; }
.bot .eyes i { width: .12em; height: .2em; margin: 0 .06em; border-radius: 999px; background: var(--wk-on-accent);
  transition: width .35s ease, height .35s ease, margin .35s ease, opacity .35s ease; }
.bot .eyes i:nth-child(3) { width: 0; margin: 0; opacity: 0; }
.head .bot .orb::before { animation: wk-spin 8s linear infinite; }
.head .bot .orb2::before { animation: wk-spin 1.6s linear infinite; }
.head .bot::after { content: ""; position: absolute; inset: 0; z-index: -3; border-radius: 50%; opacity: 0;
  transition: opacity .6s ease; animation: wk-ring 1.4s infinite ease-out; }
.head .bot .eyes { animation: wk-look 9s infinite ease-in-out; }
.head .bot .eyes i { animation: wk-blink 4.6s infinite; }
.wk.thinking .head .bot .orb2, .wk.thinking .head .bot::after { opacity: 1; }
.wk.thinking .head .bot .eyes i { width: .11em; height: .11em; margin: 0 .035em; opacity: 1; animation: wk-hop .9s infinite ease-in-out; }
.wk.thinking .head .bot .eyes i:nth-child(2) { animation-delay: .12s; }
.wk.thinking .head .bot .eyes i:nth-child(3) { animation-delay: .24s; }
.typing .think { font-size: 13px; padding-bottom: 4px;
  background: linear-gradient(90deg, var(--wk-muted) 40%, var(--wk-text) 50%, var(--wk-muted) 60%) 0 0 / 300% 100%;
  -webkit-background-clip: text; background-clip: text; color: transparent; animation: wk-shimmer 2s linear infinite; }
.row.agent .mini.bot.live { animation: wk-pop .45s cubic-bezier(.2,.8,.2,1) both; }
.avatar:not(.bot)::after { content: ""; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(115deg, transparent 35%, rgba(255,255,255,.5) 50%, transparent 65%) no-repeat;
  background-size: 300% 100%; background-position: 150% 0; animation: wk-sheen 7s 1.2s infinite ease-in-out; }
.titles { flex: 1; min-width: 0; }
.title { font-size: 16px; font-weight: 650; letter-spacing: -0.015em; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.subtitle { font-size: 12.5px; color: var(--wk-muted); margin-top: 3px; display: flex; align-items: center; gap: 6px; min-width: 0; }
.subtitle span:last-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dot { flex: none; }
.dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 3px color-mix(in srgb, #22c55e 20%, transparent); }
.icon-btn { width: 32px; height: 32px; border: 0; border-radius: 10px; background: transparent; color: var(--wk-muted);
  display: grid; place-items: center; cursor: pointer; transition: background .15s, color .15s; }
.icon-btn:hover { background: color-mix(in srgb, var(--wk-text) 7%, transparent); color: var(--wk-text); }
.icon-btn svg { width: 18px; height: 18px; }

.log { flex: 1; overflow-y: auto; padding: 18px 16px 8px; display: flex; flex-direction: column; gap: 6px;
  background: transparent; scroll-behavior: smooth; }
.log::-webkit-scrollbar { width: 8px; }
.log::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--wk-text) 15%, transparent); border-radius: 8px; }

.row { display: flex; gap: 8px; align-items: flex-end; animation: wk-in .25s cubic-bezier(.2,.8,.2,1); }
.row.user { justify-content: flex-end; }
.row + .row.gap { margin-top: 8px; }
.row .mini, .typing .mini { width: 26px; height: 26px; border-radius: 9px; flex: none; display: grid; place-items: center; overflow: hidden;
  background: var(--wk-accent); color: var(--wk-on-accent); font-size: 11px; font-weight: 700; }
.row .mini img, .typing .mini img { width: 100%; height: 100%; object-fit: cover; }
.row .mini svg, .typing .mini svg { width: 15px; height: 15px; }
.row .mini.staff { background: color-mix(in srgb, var(--wk-text) 85%, transparent); color: var(--wk-bg); }
.row .mini.hidden { visibility: hidden; }
.col { display: flex; flex-direction: column; max-width: 82%; }
.atts { display: flex; flex-direction: column; gap: 6px; margin: 2px 0 6px; }
.msg.bare { padding: 0; background: transparent !important; border: 0 !important; box-shadow: none !important; }
.msg.bare .atts { margin: 0; }
.att-img { display: block; border-radius: 12px; overflow: hidden; line-height: 0; border: 1px solid var(--wk-border); }
.att-img img { display: block; max-width: 100%; max-height: 260px; object-fit: cover; }
.att-file { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 10px; text-decoration: none !important;
  color: inherit !important; background: color-mix(in srgb, currentColor 9%, transparent); }
.att-file svg { width: 20px; height: 20px; flex: none; opacity: .8; }
.att-file span { display: flex; flex-direction: column; min-width: 0; }
.att-file b { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.att-file small { font-size: 11.5px; opacity: .7; }
.att-file.expired { opacity: .55; background: none; border: 1px dashed color-mix(in srgb, currentColor 35%, transparent); }
.att-file.expired b { text-decoration: line-through; font-weight: 500; }
.tray { display: none; gap: 6px; flex-wrap: wrap; margin: 0 0 8px; }
.tray.on { display: flex; }
.tray.busy { opacity: .55; pointer-events: none; }
.pend { display: flex; align-items: center; gap: 6px; max-width: 180px; padding: 4px 4px 4px 4px; border-radius: 10px;
  background: var(--wk-surface); border: 1px solid var(--wk-border); font-size: 12px; color: var(--wk-text); }
.pend img, .pend .fi { width: 28px; height: 28px; border-radius: 7px; object-fit: cover; flex: none; display: grid; place-items: center; color: var(--wk-muted); }
.pend .fi svg { width: 16px; height: 16px; }
.pend .pn { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.pend button { width: 20px; height: 20px; flex: none; border: 0; border-radius: 6px; background: transparent; color: var(--wk-muted); cursor: pointer; display: grid; place-items: center; padding: 0; }
.pend button:hover { color: var(--wk-text); }
.pend button svg { width: 13px; height: 13px; }
.attach { width: 30px; height: 36px; flex: none; border: 0; background: transparent; color: var(--wk-muted); cursor: pointer; display: grid; place-items: center; padding: 0; margin-left: -6px; border-radius: 10px; }
.attach:hover { color: var(--wk-text); }
.attach svg { width: 19px; height: 19px; }
.wk.dropping .panel::after { content: "Drop files to attach"; position: absolute; inset: 8px; z-index: 5; display: grid; place-items: center;
  border: 2px dashed var(--wk-accent); border-radius: calc(var(--wk-radius) * .8); background: color-mix(in srgb, var(--wk-bg) 85%, transparent);
  color: var(--wk-text); font-size: 14px; font-weight: 600; pointer-events: none; }
.meta { font-size: 11.5px; color: var(--wk-muted); margin: 5px 0 6px 4px; }
.row.cont { margin-top: -2px; }
.avatar.person { display: grid; place-items: center; font-size: 15px; font-weight: 650; letter-spacing: .02em;
  background: color-mix(in srgb, var(--wk-text) 88%, transparent); color: var(--wk-bg); }
.wk.waiting .dot { background: #f59e0b; box-shadow: 0 0 0 3px color-mix(in srgb, #f59e0b 22%, transparent); }
.row.user .col { align-items: flex-end; }
.who { font-size: 11.5px; color: var(--wk-muted); margin: 0 0 4px 2px; display: flex; gap: 6px; align-items: center; }
.tag { font-size: 10px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em; padding: 1px 6px; border-radius: 6px;
  background: color-mix(in srgb, var(--wk-accent) 14%, transparent); color: var(--wk-accent); }
.msg { padding: 10px 14px; border-radius: calc(var(--wk-radius) * .8); font-size: 14.5px; line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere; }
.msg a { color: inherit; text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px; }
.msg code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; padding: 1px 5px; border-radius: 6px;
  background: color-mix(in srgb, currentColor 10%, transparent); }
.msg .code { margin: 8px 0; border-radius: 10px; overflow: hidden; white-space: normal; border: 1px solid var(--wk-border);
  background: color-mix(in srgb, var(--wk-text) 6%, var(--wk-surface)); }
.msg .code:first-child { margin-top: 2px; } .msg .code:last-child { margin-bottom: 2px; }
.code-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 6px 4px 12px;
  font-size: 11.5px; color: var(--wk-muted); border-bottom: 1px solid var(--wk-border); }
.code-bar .copy { font: inherit; color: inherit; background: none; border: 0; padding: 3px 8px; border-radius: 6px; cursor: pointer; }
.code-bar .copy:hover { background: color-mix(in srgb, var(--wk-text) 8%, transparent); color: var(--wk-text); }
.msg pre { margin: 0; padding: 10px 12px; overflow-x: auto; white-space: pre; overflow-wrap: normal; font-size: 12.5px; line-height: 1.55; }
.msg pre code { padding: 0; background: none; font-size: inherit; border-radius: 0; }
.col:has(.code) { width: 100%; } .col:has(.code) .msg { min-width: 0; }
.row.user .msg { background: var(--wk-accent); color: var(--wk-on-accent); border-bottom-right-radius: 6px; }
.row.agent .msg, .row.staff .msg { background: var(--wk-bubble); border: 1px solid var(--wk-border);
  box-shadow: 0 1px 2px rgba(15,15,30,.04); }
.row.agent a, .row.staff a { color: var(--wk-accent); }
/* A report's progress: one slim row with a hairline track, accent while open, green when done. */
.ticket { --tk: color-mix(in srgb, var(--wk-text) 70%, var(--wk-muted)); position: relative; overflow: hidden; align-self: flex-start; max-width: 85%; margin: 8px 0 2px;
  display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 0 10px; padding: 9px 14px 11px 10px;
  border-radius: calc(var(--wk-radius) * .7); background: var(--wk-bubble); border: 1px solid var(--wk-border);
  animation: wk-pop .45s cubic-bezier(.2,.8,.2,1) both; }
.ticket.done { --tk: #22c55e; }
.tk-ic { grid-row: span 2; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%;
  color: var(--tk); background: color-mix(in srgb, var(--tk) 14%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tk) 28%, transparent); }
.tk-ic svg { width: 13px; height: 13px; }
.ticket.done .tk-ic { color: #fff; background: var(--tk); box-shadow: 0 0 12px color-mix(in srgb, var(--tk) 35%, transparent); }
.tk-title { min-width: 0; font-size: 13.5px; font-weight: 600; line-height: 1.3; color: var(--wk-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tk-sub { min-width: 0; margin-top: 1px; font-size: 11.5px; line-height: 1.3; color: var(--wk-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tk-sub b { font-weight: 600; color: var(--tk); }
.tk-bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: color-mix(in srgb, var(--tk) 12%, transparent); }
.tk-bar::after { content: ""; position: absolute; inset: 0 auto 0 0; width: var(--tk-at, 66%); border-radius: 0 2px 2px 0;
  background: linear-gradient(90deg, color-mix(in srgb, var(--tk) 55%, transparent), var(--tk)); }
.ticket.logged .tk-bar::after { animation: wk-tk 2.4s ease-in-out infinite; }
@keyframes wk-tk { 50% { opacity: .55; } }
.conv .rnew { display: inline-block; width: 7px; height: 7px; margin-right: 8px; border-radius: 50%; background: #ef4444; }
.conv.unread .ct { font-weight: 700; }
.conv.has-rep .cw { display: flex; align-items: center; }
.conv.resolved .ct { color: color-mix(in srgb, var(--wk-text) 72%, var(--wk-muted)); font-weight: 550; }
.conv .res { display: inline-flex; align-items: center; gap: 4px; font-style: normal; }
.conv .res svg { width: 11px; height: 11px; stroke-width: 3; }
.rchip { display: inline-flex; align-items: center; gap: 3px; font-style: normal; font-size: 12px; color: var(--wk-muted); }
.rchip.done { color: #22c55e; font-weight: 600; }
.rchip svg { width: 11px; height: 11px; stroke-width: 3.2; }
.wk.dark .row.agent a, .wk.dark .row.staff a { color: color-mix(in srgb, var(--wk-accent) 60%, white); }
.system { align-self: center; margin: 10px 0; font-size: 12px; color: var(--wk-muted); padding: 5px 12px; border-radius: 999px;
  background: color-mix(in srgb, var(--wk-text) 5%, transparent); animation: wk-in .25s ease; text-align: center; }
.system.done { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; color: var(--wk-text); padding: 6px 12px 6px 8px;
  background: color-mix(in srgb, #22c55e 12%, transparent); }
.system.done svg { width: 16px; height: 16px; padding: 2px; border-radius: 50%; background: #22c55e; color: #fff; box-sizing: border-box; }

.typing { display: none; gap: 8px; align-items: flex-end; margin-top: 6px; }
.typing.on { display: flex; }
.typing .msg { display: inline-flex; gap: 4px; padding: 14px 14px; background: var(--wk-bubble); border: 1px solid var(--wk-border); border-bottom-left-radius: 6px; }
.typing .msg i { width: 6px; height: 6px; border-radius: 50%; background: var(--wk-muted); animation: wk-bounce 1.2s infinite ease-in-out; }
.typing .msg i:nth-child(2) { animation-delay: .15s; }
.typing .msg i:nth-child(3) { animation-delay: .3s; }

.chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 4px 34px; }
/* Conversation list */
.recent { margin: 18px 0 4px; display: flex; flex-direction: column; gap: 8px; }
.recent-h { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; font-weight: 600;
  text-transform: uppercase; letter-spacing: .04em; color: var(--wk-muted); padding: 0 2px; }
.linkish { border: 0; background: none; padding: 0; font: inherit; font-size: 12.5px; text-transform: none; letter-spacing: 0;
  color: var(--wk-accent); cursor: pointer; font-weight: 600; }
.wk.dark .linkish { color: color-mix(in srgb, var(--wk-accent) 60%, white); }
.conv { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; width: 100%; text-align: left; font: inherit; color: inherit;
  padding: 12px 14px; border-radius: 14px; border: 1px solid var(--wk-border); background: var(--wk-bubble); cursor: pointer;
  transition: border-color .15s, transform .15s; }
.conv:hover { border-color: color-mix(in srgb, var(--wk-accent) 40%, var(--wk-border)); transform: translateY(-1px); }
.conv:focus-visible { outline: 3px solid color-mix(in srgb, var(--wk-accent) 45%, transparent); outline-offset: 2px; }
.conv .ct { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.conv .cw { font-size: 12px; color: var(--wk-muted); }
.conv .cl { grid-column: 1 / -1; font-size: 13px; color: var(--wk-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.conv .cl b { font-weight: 600; color: var(--wk-text); }
.empty { color: var(--wk-muted); font-size: 14px; text-align: center; padding: 32px 0; }
.new-conv { margin-top: 6px; align-self: center; border: 0; border-radius: 999px; padding: 10px 18px; font: inherit; font-size: 14px;
  font-weight: 600; background: var(--wk-accent); color: var(--wk-on-accent); cursor: pointer; }
.wk.list .composer { display: none; }
/* A resolved conversation offers a fresh start instead of the message box. */
.closed { display: none; flex-direction: column; align-items: center; gap: 10px; padding: 4px 0 2px; }
.wk.resolved .closed { display: flex; }
.wk.resolved .field, .wk.resolved .tray, .wk.resolved .email { display: none !important; }
.closed .new-conv { margin: 0; width: 100%; padding: 12px 18px; border-radius: calc(var(--wk-radius) * .8); display: inline-flex;
  align-items: center; justify-content: center; gap: 8px; transition: transform .15s, box-shadow .15s;
  box-shadow: 0 6px 16px color-mix(in srgb, var(--wk-accent) 28%, transparent); }
.closed .new-conv:hover { transform: translateY(-1px); }
.closed .new-conv svg { width: 16px; height: 16px; }
.closed .linkish { font-weight: 550; color: var(--wk-muted) !important; }
.closed .linkish:hover { color: var(--wk-text) !important; }
.wk.list .titles .subtitle { display: none; }
.wk.home .hist { display: none; }
.chip { border: 1px solid color-mix(in srgb, var(--wk-accent) 35%, var(--wk-border)); background: var(--wk-bg); color: var(--wk-accent);
  border-radius: 999px; padding: 7px 13px; font-size: 13px; font-weight: 550; cursor: pointer; transition: background .15s, transform .15s; }
.wk.dark .chip { color: color-mix(in srgb, var(--wk-accent) 60%, white); }
.chip:hover { background: color-mix(in srgb, var(--wk-accent) 8%, var(--wk-bg)); transform: translateY(-1px); }

.composer { padding: 12px; background: var(--wk-bg); border-top: 1px solid var(--wk-border); }
.field { display: flex; align-items: flex-end; gap: 8px; padding: 6px 6px 6px 14px; border-radius: calc(var(--wk-radius) * .8);
  border: 1px solid var(--wk-border); background: var(--wk-surface); transition: border-color .15s, box-shadow .15s; }
.field:focus-within { border-color: color-mix(in srgb, var(--wk-accent) 60%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--wk-accent) 12%, transparent); }
textarea { flex: 1; resize: none; border: 0; outline: 0; background: transparent; color: var(--wk-text); font: inherit;
  font-size: 14.5px; line-height: 1.45; padding: 7px 0; max-height: 140px; min-height: 22px; }
textarea::placeholder { color: var(--wk-muted); }
.send { width: 36px; height: 36px; flex: none; border: 0; border-radius: 12px; background: var(--wk-accent); color: var(--wk-on-accent);
  display: grid; place-items: center; cursor: pointer; transition: transform .15s, opacity .15s; }
.send:hover:not(:disabled) { transform: scale(1.05); }
.send:disabled { opacity: .35; cursor: default; }
.send svg { width: 18px; height: 18px; }
.email { display: none; align-items: center; gap: 6px; margin: 0 0 8px; padding: 8px 8px 8px 12px; border: 1px solid var(--wk-border); border-radius: 12px; background: var(--wk-surface); font-size: 12.5px; color: var(--wk-muted); }
.email.on { display: flex; flex-wrap: wrap; }
.email span { flex: 1 1 100%; }
.email input { flex: 1; min-width: 0; font: inherit; font-size: 13px; color: var(--wk-text); background: var(--wk-bubble); border: 1px solid var(--wk-border); border-radius: 8px; padding: 6px 8px; outline: none; }
.email input:focus { border-color: var(--wk-accent); }
.email button { font: inherit; font-size: 12.5px; border: 0; border-radius: 8px; padding: 6px 10px; cursor: pointer; background: var(--wk-accent); color: var(--wk-on-accent); }
.email button.skip { background: transparent; color: var(--wk-muted); padding: 6px; }
.error { color: #dc2626; font-size: 12.5px; padding: 0 4px 8px; display: none; }
.error.on { display: block; }
.brand { text-align: center; font-size: 11px; color: var(--wk-muted); padding-top: 8px; }
.brand a { color: inherit; text-decoration: none; font-weight: 600; }

@keyframes wk-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes wk-sheen { 0%, 80% { background-position: 150% 0; } 100% { background-position: -50% 0; } }
@keyframes wk-spin { to { transform: rotate(360deg); } }
@keyframes wk-shimmer { from { background-position: 100% 0; } to { background-position: 0 0; } }
@keyframes wk-blink { 0%, 90%, 96%, 100% { transform: scaleY(1); } 93% { transform: scaleY(.1); } }
@keyframes wk-look { 0%, 28%, 100% { transform: none; } 34%, 52% { transform: translateX(-.05em); } 58%, 76% { transform: translate(.05em, -.03em); } }
@keyframes wk-hop { 0%, 60%, 100% { transform: translateY(0); } 30% { transform: translateY(-.1em); } }
@keyframes wk-ring { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--wk-accent) 55%, transparent); } 100% { box-shadow: 0 0 0 9px transparent; } }
@keyframes wk-pop { 0% { transform: scale(.4); opacity: 0; } 70% { transform: scale(1.12); opacity: 1; } 100% { transform: none; } }
@keyframes wk-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: .5; } 30% { transform: translateY(-4px); opacity: 1; } }

/* Phones: the chat takes the whole screen and follows the keyboard, so nothing hides behind it.
   Fields are 16px, below which iOS zooms the page in on focus. */
.wk.page .launcher, .wk.page .x { display: none !important; }
.wk.page .panel { inset: 0; margin: auto; width: min(460px, calc(100vw - 32px)); height: min(780px, calc(100dvh - 48px)); max-height: none; }
@media (max-width: 640px) {
  .panel { inset: auto 0 auto 0; top: var(--wk-vtop, 0px); width: 100%; height: var(--wk-vh, 100dvh); max-height: none;
    border-radius: 0; border: 0; box-shadow: none; transform-origin: bottom center; }
  .left .panel { left: 0; }
  .wk.page .panel { inset: auto 0 auto 0; top: var(--wk-vtop, 0px); margin: 0; width: 100%; height: var(--wk-vh, 100dvh); }
  .wk.open .launcher { display: none; }
  .head { padding-top: env(safe-area-inset-top); }
  .composer { padding-bottom: max(12px, env(safe-area-inset-bottom)); }
  textarea, .email input { font-size: 16px; }
  .log { overscroll-behavior: contain; }
}
@media (prefers-reduced-motion: reduce) {
  .launcher, .panel, .row, .system, .chip, .send, .launcher svg, .glow, .hero, .ticket, .tk-bar::after { transition: none !important; animation: none !important; }
  .typing i, .avatar, .avatar::after, .mini, .bot .orb::before, .bot .orb2::before, .bot .eyes, .bot .eyes i, .typing .think { animation: none !important; }
}
`;

const ICONS = {
  bug: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9a4 4 0 0 1 8 0v5a4 4 0 0 1-8 0z"/><path d="M12 9v9M4 13h4M16 13h4M5 7l3 2M19 7l-3 2M5 19l3-2M19 19l-3-2M10 5 9 3M14 5l1-2"/></svg>`,
  idea: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1.1 2.2h5c.1-1 .5-1.7 1.1-2.2A6 6 0 0 0 12 3z"/></svg>`,
  book: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5M9 7h6"/></svg>`,
  chat: `<svg class="ic-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>`,
  close: `<svg class="ic-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>`,
  x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17 19 7"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.4 3.6a2 2 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  clip: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.4 11.1-8.8 8.8a5.5 5.5 0 0 1-7.8-7.8l8.8-8.8a3.7 3.7 0 0 1 5.2 5.2l-8.8 8.8a1.8 1.8 0 0 1-2.6-2.6l8.1-8.1"/></svg>`,
  file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5Z"/><path d="M14 2v6h6"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`,
  history: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>`,
  spark: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5c.4 3.9 1.9 6.3 4.3 7.6 1.2.7 2.6 1.1 4.2 1.4v1c-3.9.4-6.3 1.9-7.6 4.3-.7 1.2-1.1 2.6-1.4 4.2h-1c-.4-3.9-1.9-6.3-4.3-7.6-1.2-.7-2.6-1.1-4.2-1.4v-1c3.9-.4 6.3-1.9 7.6-4.3.7-1.2 1.1-2.6 1.4-4.2Z"/></svg>`,
};

class Widget {
  private halftone!: Halftone;
  private opts: InitOptions & { apiUrl: string };
  private theme: Theme;
  private root: ShadowRoot;
  private wrap!: HTMLElement;
  private log!: HTMLElement;
  private typing!: HTMLElement;
  private chips!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private tray!: HTMLElement;
  private pending: { file: File; preview: string | null }[] = [];
  private sendBtn!: HTMLButtonElement;
  private errorEl!: HTMLElement;
  private emailEl!: HTMLFormElement;
  private given: InitOptions;
  private givenTheme: Theme = {};
  private session: Session | null = null;
  private sessionPath = "";
  private sessionSeq = 0;
  private badge!: HTMLElement;
  private conv: { id: string; token: string } | null = null;
  private source: EventSource | null = null;
  private seen = new Set<number>();
  private lastId = 0;
  private lastAuthor: string | null = null;
  private lastRow: HTMLElement | null = null;
  private staffName: string | null = null;
  private status = "agent";
  /** The person chose to keep writing in a resolved conversation rather than start a new one. */
  private replyAnyway = false;
  private unread = 0;
  private media = window.matchMedia?.("(prefers-color-scheme: dark)");

  constructor(options: InitOptions) {
    options = defined(options);
    const apiUrl = (options.apiUrl ?? (scriptSrc ? new URL(scriptSrc).origin : location.origin)).replace(/\/$/, "");
    this.given = options;
    this.opts = { ...DEFAULTS, ...defined(options), apiUrl };
    this.givenTheme = defined(options.theme ?? {});
    if (options.accentColor && !this.givenTheme.accentColor) this.givenTheme.accentColor = options.accentColor;
    this.theme = { mode: "auto", position: "right", ...this.givenTheme };

    const host = document.createElement("div");
    host.setAttribute("data-wicket", "");
    document.body.appendChild(host);
    this.root = host.attachShadow({ mode: "open" });
    this.render();
    this.applyTheme();
    this.media?.addEventListener?.("change", () => this.applyTheme());
    document.addEventListener("visibilitychange", () => this.sendPresence());
    if (options.conversation) {
      this.conv = options.conversation;
      this.store();
      this.saveList([options.conversation, ...this.loadList()]);
      // Opened from an email, so we already have their address.
      try {
        localStorage.setItem(`${this.storageKey()}:email:${options.conversation.id}`, "1");
      } catch {}
    } else this.conv = this.loadStored();
    if (this.conv) this.connect();
    void this.checkNews();
    if (options.page) {
      this.wrap.classList.add("page");
      this.open();
    }
    void this.refreshSession();
    setInterval(() => {
      for (const t of this.log.querySelectorAll<HTMLElement>("time[data-t]")) t.textContent = timeAgo(Number(t.dataset.t), true);
    }, 30_000);
  }

  open() {
    if (location.pathname !== this.sessionPath) void this.refreshSession();
    this.wrap.classList.add("open");
    this.fitToScreen(true);
    this.halftone.play();
    this.setUnread(0);
    this.sendPresence();
    setTimeout(() => this.input.focus(), 50);
  }

  close() {
    if (this.opts.page) return;
    this.wrap.classList.remove("open");
    this.sendPresence();
    this.fitToScreen(false);
    this.halftone.pause();
  }

  private viewportListener?: () => void;
  private pageOverflow: string | null = null;

  /**
   * On a phone the chat is fullscreen: the page behind it stops scrolling, and the panel tracks the
   * visible area so the on-screen keyboard never covers the message box.
   */
  private fitToScreen(on: boolean) {
    const phone = window.matchMedia?.("(max-width: 640px)").matches;
    const vv = window.visualViewport;
    const host = this.root.host as HTMLElement;
    if (on && phone) {
      if (this.pageOverflow === null) {
        this.pageOverflow = document.documentElement.style.overflow;
        document.documentElement.style.overflow = "hidden";
      }
      if (vv && !this.viewportListener) {
        this.viewportListener = () => {
          host.style.setProperty("--wk-vh", `${vv.height}px`);
          host.style.setProperty("--wk-vtop", `${vv.offsetTop}px`);
          this.scrollDown();
        };
        this.viewportListener();
        vv.addEventListener("resize", this.viewportListener);
        vv.addEventListener("scroll", this.viewportListener);
      }
      return;
    }
    if (this.pageOverflow !== null) {
      document.documentElement.style.overflow = this.pageOverflow;
      this.pageOverflow = null;
    }
    if (vv && this.viewportListener) {
      vv.removeEventListener("resize", this.viewportListener);
      vv.removeEventListener("scroll", this.viewportListener);
      this.viewportListener = undefined;
      host.style.removeProperty("--wk-vh");
      host.style.removeProperty("--wk-vtop");
    }
  }

  toggle() {
    this.wrap.classList.contains("open") ? this.close() : this.open();
  }

  setUser(user: User) {
    this.opts.user = user;
    this.renderWelcome();
  }

  setUserToken(token: InitOptions["userToken"]) {
    this.opts.userToken = token;
    void this.refreshSession();
  }

  setContext(context: Record<string, unknown>) {
    this.opts.context = { ...(this.opts.context ?? {}), ...context };
    void this.refreshSession();
  }

  /** Asks the server which profile applies here (it depends on the page and who's signed in). */
  private async refreshSession() {
    this.sessionPath = location.pathname;
    const seq = ++this.sessionSeq;
    try {
      const res = await fetch(`${this.opts.apiUrl}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userToken: await this.userToken(), context: this.collectContext() }),
      });
      if (!res.ok || seq !== this.sessionSeq) return;
      this.session = (await res.json()) as Session;
      this.applySession();
    } catch {}
  }

  /** Options passed to init() win, then the profile's settings, then the defaults. */
  private applySession() {
    const s = this.session;
    if (!s) return;
    const o = this.opts as unknown as Record<string, unknown>;
    for (const key of UI_KEYS) {
      o[key] = (this.given as unknown as Record<string, unknown>)[key] ?? s.ui[key] ?? (s.ai ? undefined : TEAM_ONLY_DEFAULTS[key]) ?? DEFAULTS[key as keyof typeof DEFAULTS];
    }
    this.wrap.classList.toggle("team-only", !s.ai);
    if (s.theme) {
      // The server's theme fills in what init() didn't set; cssVars merge so both can add variables.
      this.theme = {
        mode: "auto",
        position: "right",
        ...defined(s.theme),
        ...this.givenTheme,
        cssVars: { ...(s.theme.cssVars ?? {}), ...(this.givenTheme.cssVars ?? {}) },
      };
      this.applyTheme();
    }
    this.updateHeader();
    this.wrap.querySelector(".ask")!.textContent = this.opts.welcomeSubtitle ?? "";
    this.input.placeholder = this.opts.placeholder ?? "";
    this.renderWelcome();
    this.renderChips();
    this.updateEmailAsk();
  }

  private async userToken(): Promise<string | undefined> {
    const t = this.opts.userToken;
    if (!t) return undefined;
    try {
      return typeof t === "function" ? await t() : t;
    } catch {
      return undefined;
    }
  }

  /** Offers an email field in a conversation when the profile asks for one and we don't know it. */
  private updateEmailAsk() {
    const show = Boolean(this.conv && this.session?.askEmail && !this.opts.user?.email && !this.emailDone(this.conv.id));
    this.emailEl.classList.toggle("on", show);
  }

  private emailDone(id: string): boolean {
    try {
      return localStorage.getItem(`${this.storageKey()}:email:${id}`) === "1";
    } catch {
      return false;
    }
  }

  private async saveEmail(skip = false) {
    if (!this.conv) return;
    const input = this.emailEl.querySelector("input")!;
    if (!skip) {
      try {
        await this.api(`/api/conversations/${this.conv.id}/email`, { email: input.value });
      } catch (err) {
        this.showError(err instanceof Error ? err.message : "Couldn't save that email.");
        return;
      }
      this.showError("");
    }
    try {
      localStorage.setItem(`${this.storageKey()}:email:${this.conv.id}`, "1");
    } catch {}
    this.updateEmailAsk();
  }

  setTheme(theme: Theme) {
    this.givenTheme = { ...this.givenTheme, ...defined(theme) };
    this.theme = { ...this.theme, ...theme };
    this.applyTheme();
  }

  private applyTheme() {
    const t = this.theme;
    const s = this.wrap.style;
    const accent = t.accentColor ?? "#4f46e5";
    s.setProperty("--wk-accent", accent);
    s.setProperty("--wk-on-accent", readableOn(accent));
    if (t.radius !== undefined) s.setProperty("--wk-radius", `${t.radius}px`);
    if (t.fontFamily) s.setProperty("--wk-font", t.fontFamily);
    if (t.offset?.x !== undefined) s.setProperty("--wk-x", `${t.offset.x}px`);
    if (t.offset?.y !== undefined) s.setProperty("--wk-y", `${t.offset.y}px`);
    if (t.zIndex !== undefined) s.setProperty("--wk-z", String(t.zIndex));
    for (const [k, v] of Object.entries(t.cssVars ?? {})) if (k.startsWith("--")) s.setProperty(k, v);
    const dark = t.mode === "dark" || (t.mode !== "light" && Boolean(this.media?.matches));
    this.wrap.classList.toggle("dark", dark);
    this.wrap.classList.toggle("left", t.position === "left");
    this.halftone?.setColor(accent, !dark);
  }

  private renderWelcome() {
    const first = (this.opts.user?.name ?? this.session?.name)?.trim().split(/\s+/)[0];
    this.wrap.querySelector(".hello")!.textContent = this.opts.welcomeTitle ?? `Hi${first ? ` ${first}` : ""} 👋`;
  }

  private avatarHtml(cls = "avatar") {
    if (this.opts.logoUrl) return `<div class="${cls}"><img alt="" src="${escapeAttr(this.opts.logoUrl)}"></div>`;
    return `<div class="${cls} bot" aria-hidden="true"><span class="orb"></span><span class="orb2"></span><span class="eyes"><i></i><i></i><i></i></span></div>`;
  }

  private render() {
    const style = document.createElement("style");
    style.textContent = CSS;
    const o = this.opts;
    this.wrap = document.createElement("div");
    this.wrap.className = "wk";
    this.wrap.innerHTML = `
      <section class="panel" role="dialog" aria-label="${escapeAttr(o.title!)}">
        <canvas class="glow" aria-hidden="true"></canvas>
        <header class="head">
          <div class="bar">
          ${this.avatarHtml()}
          <div class="titles">
            <div class="title">${escapeHtml(o.title!)}</div>
            ${o.subtitle ? `<div class="subtitle"><span class="dot"></span><span>${escapeHtml(o.subtitle)}</span></div>` : ""}
          </div>
          <button class="icon-btn hist" title="Your conversations" aria-label="Your conversations">${ICONS.history}</button>
          <button class="icon-btn new" title="New conversation" aria-label="New conversation">${ICONS.plus}</button>
          <button class="icon-btn x" title="Close" aria-label="Close">${ICONS.x}</button>
          </div>
          <div class="hero"><div><div class="hello"></div><div class="ask">${escapeHtml(o.welcomeSubtitle ?? "")}</div>${o.greeting ? `<p class="greet">${escapeHtml(o.greeting)}</p>` : ""}</div></div>
        </header>
        <div class="log" aria-live="polite"></div>
        <div class="composer">
          <div class="error" role="alert"></div>
          <form class="email"><span>Leave your email so the team can follow up if you're away.</span><input type="email" placeholder="you@example.com" aria-label="Email" autocomplete="email"><button type="submit">Save</button><button class="skip" type="button">No thanks</button></form>
          <div class="tray" aria-label="Attachments"></div>
          <div class="closed">
            <button class="new-conv" type="button">${ICONS.plus}<span>Start a new conversation</span></button>
            <button class="linkish reopen" type="button">Reply here instead</button>
          </div>
          <form class="field">
            <button class="attach" type="button" title="Attach a file" aria-label="Attach a file">${ICONS.clip}</button>
            <input class="file-input" type="file" multiple accept="${ACCEPT}" hidden>
            <textarea rows="1" placeholder="${escapeAttr(o.placeholder!)}" aria-label="Message"></textarea>
            <button class="send" type="submit" aria-label="Send" disabled>${ICONS.send}</button>
          </form>
          ${o.showBranding ? `<div class="brand">Powered by <a href="https://github.com/Stixels/wicket" target="_blank" rel="noopener">Wicket</a></div>` : ""}
        </div>
      </section>
      <button class="launcher${o.launcherLabel ? "" : " icon-only"}" aria-label="${escapeAttr(o.title!)}">
        ${ICONS.chat}${ICONS.close}${o.launcherLabel ? `<span class="label">${escapeHtml(o.launcherLabel)}</span>` : ""}
        <span class="badge" aria-hidden="true"></span>
      </button>`;
    this.root.append(style, this.wrap);

    const launcher = this.wrap.querySelector<HTMLButtonElement>(".launcher")!;
    if (o.hideLauncher) launcher.style.display = "none";
    this.badge = this.wrap.querySelector(".badge")!;
    this.log = this.wrap.querySelector(".log")!;
    this.halftone = new Halftone(this.wrap.querySelector("canvas")!);
    this.renderWelcome();
    const head = this.wrap.querySelector(".head")!;
    this.log.addEventListener("scroll", () => head.classList.toggle("scrolled", this.log.scrollTop > 4), { passive: true });
    this.errorEl = this.wrap.querySelector(".error")!;
    this.emailEl = this.wrap.querySelector(".email")!;
    this.emailEl.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.saveEmail();
    });
    this.emailEl.querySelector(".skip")!.addEventListener("click", () => void this.saveEmail(true));
    this.input = this.wrap.querySelector("textarea")!;
    this.sendBtn = this.wrap.querySelector(".send")!;

    this.typing = document.createElement("div");
    this.typing.className = "typing";
    // The animated bot shows its own thinking dots, so it only needs a label; a custom logo gets the usual bubble.
    this.typing.innerHTML = this.opts.logoUrl
      ? `<div class="msg" aria-label="Typing"><i></i><i></i><i></i></div>`
      : `<span class="think" role="status">Thinking…</span>`;
    this.chips = document.createElement("div");
    this.chips.className = "chips";

    launcher.addEventListener("click", () => this.toggle());
    this.wrap.querySelector(".x")!.addEventListener("click", () => this.close());
    this.wrap.querySelector(".new")!.addEventListener("click", () => this.reset());
    this.wrap.querySelector(".closed .new-conv")!.addEventListener("click", () => this.reset());
    this.wrap.querySelector(".closed .reopen")!.addEventListener("click", () => {
      this.replyAnyway = true;
      this.updateHeader();
      this.input.focus();
    });
    this.wrap.querySelector(".hist")!.addEventListener("click", () =>
      this.wrap.classList.contains("list") ? this.reset() : void this.showHistory(),
    );
    this.wrap.querySelector("form.field")!.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.send();
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send();
      }
    });
    this.input.addEventListener("input", () => this.autosize());
    this.tray = this.wrap.querySelector(".tray")!;
    const picker = this.wrap.querySelector<HTMLInputElement>(".file-input")!;
    this.wrap.querySelector(".attach")!.addEventListener("click", () => picker.click());
    picker.addEventListener("change", () => {
      this.addFiles([...(picker.files ?? [])]);
      picker.value = "";
    });
    // Pasting a screenshot, or dropping files anywhere on the panel, attaches them.
    this.input.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        e.preventDefault();
        this.addFiles(files);
      }
    });
    const panel = this.wrap.querySelector(".panel")!;
    panel.addEventListener("dragover", (e) => {
      if ([...((e as DragEvent).dataTransfer?.types ?? [])].includes("Files")) {
        e.preventDefault();
        this.wrap.classList.add("dropping");
      }
    });
    panel.addEventListener("dragleave", (e) => {
      if (!panel.contains((e as DragEvent).relatedTarget as Node)) this.wrap.classList.remove("dropping");
    });
    panel.addEventListener("drop", (e) => {
      e.preventDefault();
      this.wrap.classList.remove("dropping");
      this.addFiles([...((e as DragEvent).dataTransfer?.files ?? [])]);
    });
    this.wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    this.showGreeting();
  }

  private autosize() {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 140)}px`;
    this.sendBtn.disabled = !this.input.value.trim() && !this.pending.length;
  }

  private showGreeting() {
    this.wrap.classList.add("home");
    this.log.innerHTML = "";
    this.lastAuthor = null;
    this.lastRow = null;
    this.status = "agent";
    this.replyAnyway = false;
    this.setAgent(null);
    this.updateHeader();
    this.log.appendChild(this.typing);
    this.renderChips();
    void this.showRecent();
  }

  private renderChips() {
    if (!this.wrap.classList.contains("home")) return;
    this.chips.innerHTML = "";
    for (const s of this.opts.suggestions ?? []) {
      const chip = document.createElement("button");
      chip.className = "chip";
      chip.type = "button";
      chip.textContent = s;
      chip.addEventListener("click", () => {
        this.input.value = s.endsWith("?") || s.endsWith(".") ? s : `${s}: `;
        this.autosize();
        this.input.focus();
        if (s.endsWith("?")) void this.send();
      });
      this.chips.appendChild(chip);
    }
    if (!this.chips.childElementCount) this.chips.remove();
    else if (!this.chips.isConnected) this.log.insertBefore(this.chips, this.log.querySelector(".recent") ?? this.typing);
  }

  /** Up to three earlier conversations under the start screen. */
  private async showRecent() {
    const list = await this.summaries();
    if (!list.length || !this.wrap.classList.contains("home")) return;
    const box = document.createElement("div");
    box.className = "recent";
    box.innerHTML = `<div class="recent-h"><span>Recent</span>${list.length > 3 ? `<button class="linkish" type="button">See all</button>` : ""}</div>`;
    box.querySelector(".linkish")?.addEventListener("click", () => void this.showHistory());
    for (const c of list.slice(0, 3)) box.appendChild(this.convCard(c));
    this.log.querySelector(".recent")?.remove();
    this.log.insertBefore(box, this.typing);
  }

  private async showHistory() {
    this.source?.close();
    this.source = null;
    this.conv = null;
    this.chips.remove();
    this.wrap.classList.remove("home");
    this.wrap.classList.add("list");
    this.log.innerHTML = `<div class="empty">Loading…</div>`;
    const list = await this.summaries();
    if (!this.wrap.classList.contains("list")) return;
    this.log.innerHTML = "";
    const box = document.createElement("div");
    box.className = "recent";
    box.innerHTML = `<div class="recent-h"><span>Your conversations</span></div>`;
    for (const c of list) box.appendChild(this.convCard(c));
    if (!list.length) box.insertAdjacentHTML("beforeend", `<div class="empty">No conversations yet.</div>`);
    const start = document.createElement("button");
    start.className = "new-conv";
    start.type = "button";
    start.textContent = "Start a new conversation";
    start.addEventListener("click", () => this.reset());
    box.appendChild(start);
    this.log.appendChild(box);
  }

  private convCard(c: Summary) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "conv";
    const who = !c.last ? "" : c.last.author === "user" ? "You" : c.last.author === "staff" ? c.last.authorName ?? "Team" : c.last.author === "agent" ? "Assistant" : "";
    const r = c.report;
    if (r) {
      // A report reads as the report: its name, where it stands, and when that last changed.
      const w = ticketWords(r.kind);
      const done = r.stage === "done";
      const status = capitalize(dayLabel(done ? (r.doneAt ?? c.updatedAt) : r.reportedAt));
      el.classList.add("has-rep");
      if (c.news) el.classList.add("unread");
      el.innerHTML = `<span class="ct">${escapeHtml(capitalize(r.summary.replace(/^"(.*)"$/, "$1")))}</span><span class="cw">${c.news ? `<i class="rnew" title="New update"></i>` : ""}${reportChip(r)}</span>
        <span class="cl">${w.noun} · ${status}</span>`;
    } else {
      // Resolved conversations step back so the open ones stand out.
      if (c.status === "resolved") el.classList.add("resolved");
      el.innerHTML = `<span class="ct">${escapeHtml(c.title || "Conversation")}</span><span class="cw">${c.status === "resolved" ? `<i class="res">${ICONS.check}Resolved</i>` : timeAgo(c.updatedAt)}</span>
        <span class="cl">${who ? `<b>${escapeHtml(who)}:</b> ` : ""}${escapeHtml(c.last?.body ?? "")}</span>`;
    }
    el.addEventListener("click", () => this.openConversation(c));
    return el;
  }

  private openConversation(c: { id: string }) {
    const saved = this.loadList().find((x) => x.id === c.id);
    if (!saved) return;
    this.source?.close();
    this.source = null;
    this.conv = saved;
    this.store();
    this.seen.clear();
    this.lastId = 0;
    this.lastAuthor = null;
    this.lastRow = null;
    this.status = "agent";
    this.replyAnyway = false;
    this.setAgent(null);
    this.chips.remove();
    this.log.innerHTML = "";
    this.log.appendChild(this.typing);
    this.wrap.classList.remove("home", "list");
    this.connect();
    this.input.focus();
  }

  /** Badges the launcher for news in earlier conversations (the open one reports its own). */
  private async checkNews() {
    if (!this.opts.userToken && this.loadList().every((x) => x.id === this.conv?.id)) return;
    const n = (await this.summaries()).filter((c) => c.news && c.id !== this.conv?.id).length;
    if (n && !this.wrap.classList.contains("open")) this.setUnread(this.unread + n);
  }

  private async summaries(): Promise<Summary[]> {
    const conversations = this.loadList();
    const userToken = await this.userToken().catch(() => undefined);
    if (!conversations.length && !userToken) return [];
    try {
      const res = await fetch(`${this.opts.apiUrl}/api/conversations/summaries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversations, userToken }),
      });
      if (!res.ok) return [];
      const list = ((await res.json()).conversations ?? []) as (Summary & { token?: string })[];
      // Keep what the server knows: drops conversations it forgot (e.g. after a database reset),
      // and adds a signed-in user's conversations from other devices.
      const known = new Set(list.map((x) => x.id));
      const fromServer = list.flatMap((x) => (x.token ? [{ id: x.id, token: x.token }] : []));
      this.saveList([...conversations.filter((x) => known.has(x.id)), ...fromServer]);
      return list;
    } catch {
      return [];
    }
  }

  private reset() {
    this.replyAnyway = false;
    this.status = "agent";
    this.wrap.classList.remove("resolved");
    this.source?.close();
    this.source = null;
    this.conv = null;
    this.seen.clear();
    this.lastId = 0;
    try {
      localStorage.removeItem(this.storageKey());
    } catch {}
    this.wrap.classList.remove("list");
    this.showGreeting();
    this.input.focus();
  }

  /** Queues files to go with the next message. */
  private addFiles(files: File[]) {
    for (const file of files) {
      if (this.pending.length >= 10) break;
      if (file.size > MAX_FILE_BYTES) {
        this.showError(`${file.name} is over 10 MB.`);
        continue;
      }
      if (!ACCEPT.split(",").includes(file.type)) {
        this.showError(`${file.name} can't be attached. Try an image, PDF, video, text or zip file.`);
        continue;
      }
      this.pending.push({ file, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null });
    }
    this.renderTray();
    this.autosize();
    this.input.focus();
  }

  private renderTray() {
    this.tray.innerHTML = "";
    this.pending.forEach((p, i) => {
      const chip = document.createElement("div");
      chip.className = "pend";
      chip.innerHTML = `${p.preview ? `<img alt="" src="${escapeAttr(p.preview)}">` : `<span class="fi">${ICONS.file}</span>`}<span class="pn">${escapeHtml(p.file.name)}</span><button type="button" aria-label="Remove ${escapeAttr(p.file.name)}">${ICONS.x}</button>`;
      chip.querySelector("button")!.addEventListener("click", () => {
        if (p.preview) URL.revokeObjectURL(p.preview);
        this.pending.splice(i, 1);
        this.renderTray();
        this.autosize();
      });
      this.tray.appendChild(chip);
    });
    this.tray.classList.toggle("on", this.pending.length > 0);
  }

  private async upload(file: File): Promise<string> {
    const form = new FormData();
    form.append("file", file, file.name);
    const res = await fetch(`${this.opts.apiUrl}/api/conversations/${this.conv!.id}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.conv!.token}` },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Couldn't upload ${file.name}.`);
    return data.file.id as string;
  }

  private async send() {
    const body = this.input.value.trim();
    if ((!body && !this.pending.length) || this.input.disabled) return;
    this.input.disabled = true;
    this.sendBtn.disabled = true;
    this.showError("");
    this.leaveHome();
    try {
      if (!this.conv) {
        const res = await this.api("/api/conversations", {
          reporter: this.opts.user ?? {},
          userToken: await this.userToken(),
          context: this.collectContext(),
        });
        this.conv = { id: res.id, token: res.token };
        this.store();
        this.saveList([this.conv, ...this.loadList()]);
        this.connect();
        this.updateEmailAsk();
      }
      this.input.value = "";
      this.autosize();
      const files = [...this.pending];
      if (files.length) this.tray.classList.add("busy");
      const attachments: string[] = [];
      for (const p of files) attachments.push(await this.upload(p.file));
      const { message } = await this.api(`/api/conversations/${this.conv.id}/messages`, {
        body,
        attachments,
        context: { page: location.href },
      });
      for (const p of files) if (p.preview) URL.revokeObjectURL(p.preview);
      this.pending = [];
      this.renderTray();
      this.appendBubble(message);
    } catch (err) {
      this.input.value = this.input.value || body;
      this.showError(err instanceof Error ? err.message : "Couldn't send. Please try again.");
    } finally {
      this.tray.classList.remove("busy");
      this.input.disabled = false;
      this.autosize();
      this.input.focus();
    }
  }

  private connect() {
    if (!this.conv || this.source) return;
    const url = `${this.opts.apiUrl}/api/conversations/${this.conv.id}/events?token=${encodeURIComponent(this.conv.token)}&after=${this.lastId}&cid=${this.cid}`;
    const es = new EventSource(url);
    this.source = es;
    // A new connection starts as "not looking"; say so once it's open.
    es.addEventListener("open", () => this.sendPresence(true));
    es.addEventListener("message", (e) => {
      const m = JSON.parse((e as MessageEvent).data).message as Message;
      const fresh = !this.seen.has(m.id);
      this.appendBubble(m);
      if (fresh && m.author !== "user" && !this.wrap.classList.contains("open") && (Date.now() - m.createdAt < 60_000 || m.unseen)) {
        this.setUnread(this.unread + 1);
      }
    });
    es.addEventListener("status", (e) => {
      this.status = JSON.parse((e as MessageEvent).data).status ?? "agent";
      if (this.status !== "resolved") this.replyAnyway = false;
      if (this.status === "resolved" || this.status === "agent") this.setAgent(null);
      this.updateHeader();
    });
    es.addEventListener("typing", () => {
      this.typing.classList.add("on");
      this.startThinking();
      this.scrollDown();
    });
    es.addEventListener("idle", () => {
      this.typing.classList.remove("on");
      this.stopThinking();
    });
    es.addEventListener("error", () => {
      // A 404 means the conversation is gone (e.g. database reset): start fresh.
      if (es.readyState === EventSource.CLOSED) {
        this.source = null;
        fetch(url)
          .then((r) => r.status === 404 && this.reset())
          .catch(() => {});
      }
    });
  }

  /** This page's connection, so the team can see whether the chat is in view here. */
  private cid = Math.random().toString(36).slice(2) + Date.now().toString(36);
  private viewingSent: boolean | null = null;

  /** Tells the team whether the user is looking at the chat right now. */
  private sendPresence(force = false) {
    if (!this.conv || !this.source) return;
    const viewing = this.wrap.classList.contains("open") && document.visibilityState === "visible";
    if (!force && viewing === this.viewingSent) return;
    this.viewingSent = viewing;
    void fetch(`${this.opts.apiUrl}/api/conversations/${this.conv.id}/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.conv.token}` },
      body: JSON.stringify({ cid: this.cid, viewing }),
      keepalive: true,
    }).catch(() => {});
  }

  private thinkingStop?: () => void;

  private startThinking() {
    this.thinkingStop?.();
    this.wrap.classList.add("thinking");
  }

  /** Lets the bouncing dots finish their hop before the eyes come back, so nothing jumps. */
  private stopThinking() {
    if (!this.wrap.classList.contains("thinking") || this.thinkingStop) return;
    const dot = this.wrap.querySelector(".head .bot .eyes i");
    const done = () => {
      dot?.removeEventListener("animationiteration", done);
      clearTimeout(timer);
      this.thinkingStop = undefined;
      this.wrap.classList.remove("thinking");
    };
    const timer = setTimeout(done, 1000);
    dot?.addEventListener("animationiteration", done);
    this.thinkingStop = done;
  }

  /** From the start screen to a conversation: drop the quick starts and the Recent list. */
  private leaveHome() {
    this.wrap.classList.remove("home");
    this.chips.remove();
    this.log.querySelector(".recent")?.remove();
  }

  private appendBubble(m: Message) {
    if (m.id > 0) this.leaveHome();
    if (m.id && this.seen.has(m.id)) return;
    if (m.id) {
      this.seen.add(m.id);
      this.lastId = Math.max(this.lastId, m.id);
    }
    if (m.author !== "user") {
      this.typing.classList.remove("on");
      this.stopThinking();
    }

    if (m.card?.type === "ticket") {
      const el = document.createElement("div");
      el.className = `ticket ${m.card.stage}`;
      el.setAttribute("role", "status");
      el.innerHTML = ticketCardHtml(m.card);
      this.log.insertBefore(el, this.typing);
      this.lastAuthor = "card";
      this.scrollDown();
      return;
    }

    if (m.author === "system") {
      const el = document.createElement("div");
      el.className = "system";
      if (isResolvedNote(m.body)) {
        el.classList.add("done");
        el.innerHTML = `${ICONS.check}<span>Marked as resolved</span>`;
      } else {
        el.textContent = m.body;
      }
      this.log.insertBefore(el, this.typing);
      this.lastAuthor = "system";
      this.scrollDown();
      return;
    }

    // Consecutive messages from the same person form a group; the name and time sit under its last one.
    const groupKey = `${m.author}:${m.authorName ?? ""}`;
    const continued = this.lastAuthor === groupKey;
    this.lastAuthor = groupKey;
    if (continued) this.lastRow?.querySelector(".meta")?.remove();

    const row = document.createElement("div");
    row.className = `row ${m.author}${continued ? " cont" : " gap"}`;
    const name = m.author === "agent" ? this.opts.assistantName || "Assistant" : m.author === "staff" ? m.authorName || "Team" : "";
    const meta = m.author === "user" ? "" : `<div class="meta">${escapeHtml(name)} · <time data-t="${m.createdAt}">${timeAgo(m.createdAt, true)}</time></div>`;
    const files = (m.attachments ?? []).map((a) => this.attachmentHtml(a)).join("");
    const text = m.body ? renderMarkdown(m.body) : "";
    const onlyImages = !m.body && (m.attachments ?? []).every((a) => a.type.startsWith("image/"));
    row.innerHTML = `<div class="col"><div class="msg${onlyImages ? " bare" : ""}">${files ? `<div class="atts">${files}</div>` : ""}${text}</div>${meta}</div>`;
    for (const btn of row.querySelectorAll<HTMLButtonElement>(".code .copy")) {
      btn.addEventListener("click", () => {
        const code = btn.closest(".code")?.querySelector("pre")?.textContent ?? "";
        void navigator.clipboard?.writeText(code).then(() => {
          btn.textContent = "Copied";
          setTimeout(() => (btn.textContent = "Copy"), 1500);
        });
      });
    }
    this.log.insertBefore(row, this.typing);
    this.lastRow = row;
    if (m.author === "staff") this.setAgent(m.authorName || "Team");
    this.scrollDown();
  }

  private attachmentHtml(a: Attachment): string {
    if (a.expired) return `<span class="att-file expired">${ICONS.file}<span><b>${escapeHtml(a.name)}</b><small>No longer available</small></span></span>`;
    const url = `${this.opts.apiUrl}/files/${encodeURIComponent(a.id)}/${encodeURIComponent(a.name)}`;
    if (a.type.startsWith("image/")) {
      return `<a class="att-img" href="${escapeAttr(url)}" target="_blank" rel="noopener"><img alt="${escapeAttr(a.name)}" src="${escapeAttr(url)}" loading="lazy"></a>`;
    }
    return `<a class="att-file" href="${escapeAttr(url)}" target="_blank" rel="noopener">${ICONS.file}<span><b>${escapeHtml(a.name)}</b><small>${formatSize(a.size)}</small></span></a>`;
  }

  /** Who the header shows: the assistant, or the person from the team who picked the conversation up. */
  private setAgent(staffName: string | null) {
    if (this.staffName === staffName) return;
    this.staffName = staffName;
    const old = this.wrap.querySelector(".head .bar > .avatar")!;
    const tmp = document.createElement("div");
    tmp.innerHTML = staffName
      ? `<div class="avatar person" aria-hidden="true">${escapeHtml(initials(staffName))}</div>`
      : this.avatarHtml();
    old.replaceWith(tmp.firstElementChild!);
    this.updateHeader();
  }

  private updateHeader() {
    const title = this.wrap.querySelector(".title")!;
    const sub = this.wrap.querySelector(".subtitle span:last-child");
    this.wrap.classList.toggle("waiting", !this.staffName && this.status === "needs_human");
    this.wrap.classList.toggle("resolved", this.status === "resolved" && !this.replyAnyway && Boolean(this.conv));
    title.textContent = this.staffName ?? this.opts.title ?? "";
    if (sub) sub.textContent = this.staffName ? "Team" : this.status === "needs_human" ? "Waiting for the team…" : this.opts.subtitle ?? "";
  }

  private scrollDown() {
    requestAnimationFrame(() => (this.log.scrollTop = this.log.scrollHeight));
  }

  private setUnread(n: number) {
    this.unread = n;
    this.badge.textContent = n > 9 ? "9+" : String(n);
    this.badge.classList.toggle("on", n > 0);
  }

  private collectContext(): Record<string, unknown> {
    return {
      page: location.href,
      title: document.title,
      userAgent: navigator.userAgent,
      viewport: `${innerWidth}x${innerHeight}`,
      language: navigator.language,
      ...(this.opts.context ?? {}),
      ...(recentErrors.length ? { errors: [...recentErrors] } : {}),
    };
  }

  private async api(path: string, body: unknown) {
    const res = await fetch(`${this.opts.apiUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.conv && path !== "/api/conversations" ? { Authorization: `Bearer ${this.conv.token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404 && this.conv) {
      this.reset();
      throw new Error("That conversation expired. Please send your message again.");
    }
    if (!res.ok) throw new Error(data.error || "Couldn't send. Please try again.");
    return data;
  }

  private showError(text: string) {
    this.errorEl.textContent = text;
    this.errorEl.classList.toggle("on", Boolean(text));
  }

  private storageKey() {
    return `wicket:${this.opts.apiUrl}:${this.opts.user?.id ?? tokenSubject(this.opts.userToken) ?? "anon"}`;
  }

  private loadStored(): { id: string; token: string } | null {
    try {
      const raw = localStorage.getItem(this.storageKey());
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  private store() {
    try {
      localStorage.setItem(this.storageKey(), JSON.stringify(this.conv));
    } catch {}
  }

  /** Every conversation started in this browser, newest first. */
  private loadList(): { id: string; token: string }[] {
    let list: { id: string; token: string }[] = [];
    try {
      list = JSON.parse(localStorage.getItem(`${this.storageKey()}:all`) ?? "[]");
    } catch {}
    const current = this.loadStored();
    if (current && !list.some((x) => x.id === current.id)) list.unshift(current);
    return list;
  }

  private saveList(list: { id: string; token: string }[]) {
    try {
      const unique = list.filter((x, i) => list.findIndex((y) => y.id === x.id) === i);
      localStorage.setItem(`${this.storageKey()}:all`, JSON.stringify(unique.slice(0, 50)));
    } catch {}
  }
}

/** The user id in a token string, read without checking it (only to keep each user's history apart in this browser). */
function tokenSubject(token: InitOptions["userToken"]): string | null {
  if (typeof token !== "string") return null;
  try {
    const claims = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    return String(claims.sub ?? claims.userId ?? "") || null;
  } catch {
    return null;
  }
}

/** Drops undefined keys so they don't override defaults when spread. */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function timeAgo(ms: number, capital = false): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return capital ? "Now" : "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The words a report's card uses, by kind. */
function ticketWords(kind: string | null) {
  if (kind === "bug") return { noun: "Bug report", start: "Reported", end: "Fixed", icon: ICONS.bug, thanks: "thanks for reporting it" };
  if (kind === "docs") return { noun: "Docs", start: "Reported", end: "Updated", icon: ICONS.book, thanks: "thanks for pointing it out" };
  return { noun: "Idea", start: "Suggested", end: "Shipped", icon: ICONS.idea, thanks: "thanks for the idea" };
}

/** A report's status as quiet text: "Logged" in grey, "✓ Fixed" or "✓ Shipped" in green. */
function reportChip(c: TicketCard): string {
  const done = c.stage === "done";
  return `<i class="rchip${done ? " done" : ""}">${done ? ICONS.check : ""}${done ? ticketWords(c.kind).end : "Logged"}</i>`;
}

/** "today", or a short date like "Oct 20". */
function dayLabel(ms: number): string {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? "today" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function ticketCardHtml(c: TicketCard): string {
  const w = ticketWords(c.kind);
  const done = c.stage === "done";
  const raw = c.summary.replace(/^"(.*)"$/, "$1");
  const title = raw.charAt(0).toUpperCase() + raw.slice(1);
  const day = dayLabel;
  const others = c.others ? ` · ${c.others === 1 ? "1 other" : `${c.others} others`} too` : "";
  const sub = done
    ? `<b>${w.end}</b> ${day(c.doneAt ?? Date.now())} · ${w.thanks}`
    : `<b>Logged</b> · ${w.noun}${others} · we'll update you here`;
  return `<span class="tk-ic">${done ? ICONS.check : w.icon}</span>
    <div class="tk-title" title="${escapeAttr(title)}">${escapeHtml(title)}</div>
    <div class="tk-sub">${sub}</div>
    <i class="tk-bar" style="--tk-at:${done ? "100%" : "62%"}" aria-hidden="true"></i>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
const escapeAttr = escapeHtml;

function initials(name: string | null): string {
  const parts = (name ?? "Team").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "T";
}

/** White or near-black text, whichever reads better on the given color. */
export function readableOn(color: string): string {
  const m = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(color.trim());
  if (!m) return "#ffffff";
  const hex = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return lum > 0.4 ? "#16161d" : "#ffffff";
}

/** Minimal, safe markdown: escape everything, then allow code blocks, links, bold and inline code. */
export function renderMarkdown(text: string): string {
  // Fenced code blocks first, so nothing inside them is treated as markdown. An unclosed fence runs to the end.
  const parts = text.split(/^```[^\S\n]*([\w+#.-]*)[^\S\n]*\n([\s\S]*?)(?:^```[^\S\n]*$\n?|$(?![\s\S]))/m);
  let html = "";
  for (let i = 0; i < parts.length; i += 3) {
    // The block itself breaks the line, so drop the newlines around it.
    let prose = parts[i]!;
    if (i > 0) prose = prose.replace(/^\n+/, "");
    if (i + 3 < parts.length) prose = prose.replace(/\n+$/, "");
    html += inlineMarkdown(prose);
    if (i + 2 < parts.length) {
      const lang = parts[i + 1] ?? "";
      const code = (parts[i + 2] ?? "").replace(/\n$/, "");
      html +=
        `<div class="code"><div class="code-bar"><span>${escapeHtml(lang)}</span>` +
        `<button type="button" class="copy" aria-label="Copy code">Copy</button></div>` +
        `<pre><code>${escapeHtml(code)}</code></pre></div>`;
    }
  }
  return html;
}

function inlineMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

let instance: Widget | null = null;
const api = {
  init(options: InitOptions = {}) {
    if (!instance) instance = new Widget(options);
    return api;
  },
  open: () => instance?.open(),
  close: () => instance?.close(),
  toggle: () => instance?.toggle(),
  setUser: (user: User) => instance?.setUser(user),
  setUserToken: (token: InitOptions["userToken"]) => instance?.setUserToken(token),
  setContext: (context: Record<string, unknown>) => instance?.setContext(context),
  setTheme: (theme: Theme) => instance?.setTheme(theme),
};
(window as any).Wicket = api;

if (scriptEl?.hasAttribute("data-auto-init")) {
  const d = scriptEl.dataset;
  const start = () =>
    api.init({
      apiUrl: d.apiUrl,
      title: d.title,
      launcherLabel: d.launcherLabel,
      theme: { accentColor: d.accentColor, mode: d.theme as Theme["mode"], position: d.position as Theme["position"] },
    });
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", start) : start();
}

/** The note the server adds when the team resolves a conversation (older ones were a full sentence). */
function isResolvedNote(body: string): boolean {
  return body === "Marked as resolved" || body.startsWith("The team marked this conversation as resolved");
}
