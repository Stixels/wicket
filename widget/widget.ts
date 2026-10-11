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
  context?: Record<string, unknown>;
  title?: string;
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
  showBranding?: boolean;
  theme?: Theme;
  /** @deprecated use theme.accentColor */
  accentColor?: string;
}

interface Summary {
  id: string;
  status: string;
  title: string;
  last: { author: string; authorName: string | null; body: string; createdAt: number } | null;
  updatedAt: number;
}

interface Message {
  id: number;
  author: "user" | "agent" | "staff" | "system";
  authorName: string | null;
  body: string;
  createdAt: number;
}

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
  width: 384px; height: min(640px, calc(100vh - var(--wk-y) - 104px));
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
.wk:not(.home) .glow { height: 160px; opacity: .5; }
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
/* The assistant's mark is alive: an occasional twinkle and sheen, and it spins while thinking. */
.avatar, .row .mini, .typing .mini { position: relative; }
.avatar::after, .typing .mini::after { content: ""; position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(115deg, transparent 35%, rgba(255,255,255,.5) 50%, transparent 65%) no-repeat;
  background-size: 300% 100%; background-position: 150% 0; animation: wk-sheen 7s 1.2s infinite ease-in-out; }
.avatar svg { animation: wk-twinkle 7s 1.2s infinite ease-in-out; }
.wk.thinking .avatar svg, .typing .mini svg { animation: wk-think 1.4s infinite cubic-bezier(.45,0,.25,1); }
.wk.thinking .avatar { animation: wk-ring 1.4s infinite ease-out; }
.typing .mini::after { animation-duration: 1.4s; animation-delay: 0s; }
.row.agent .mini:not(.hidden) svg { animation: wk-pop .5s ease-out both; }
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
.col { display: flex; flex-direction: column; max-width: 80%; }
.row.user .col { align-items: flex-end; }
.who { font-size: 11.5px; color: var(--wk-muted); margin: 0 0 4px 2px; display: flex; gap: 6px; align-items: center; }
.tag { font-size: 10px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em; padding: 1px 6px; border-radius: 6px;
  background: color-mix(in srgb, var(--wk-accent) 14%, transparent); color: var(--wk-accent); }
.msg { padding: 10px 14px; border-radius: calc(var(--wk-radius) * .8); font-size: 14.5px; line-height: 1.5;
  white-space: pre-wrap; overflow-wrap: anywhere; }
.msg a { color: inherit; text-decoration: underline; text-underline-offset: 2px; text-decoration-thickness: 1px; }
.msg code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; padding: 1px 5px; border-radius: 6px;
  background: color-mix(in srgb, currentColor 10%, transparent); }
.row.user .msg { background: var(--wk-accent); color: var(--wk-on-accent); border-bottom-right-radius: 6px; }
.row.agent .msg, .row.staff .msg { background: var(--wk-bubble); border: 1px solid var(--wk-border); border-bottom-left-radius: 6px;
  box-shadow: 0 1px 2px rgba(15,15,30,.04); }
.row.agent a, .row.staff a { color: var(--wk-accent); }
.wk.dark .row.agent a, .wk.dark .row.staff a { color: color-mix(in srgb, var(--wk-accent) 60%, white); }
.system { align-self: center; margin: 10px 0; font-size: 12px; color: var(--wk-muted); padding: 5px 12px; border-radius: 999px;
  background: color-mix(in srgb, var(--wk-text) 5%, transparent); animation: wk-in .25s ease; text-align: center; }

.typing { display: none; gap: 8px; align-items: flex-end; margin-top: 6px; }
.typing.on { display: flex; }
.typing .msg { display: inline-flex; gap: 4px; padding: 14px 14px; background: var(--wk-bubble); border: 1px solid var(--wk-border); border-bottom-left-radius: 6px; }
.typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--wk-muted); animation: wk-bounce 1.2s infinite ease-in-out; }
.typing i:nth-child(2) { animation-delay: .15s; }
.typing i:nth-child(3) { animation-delay: .3s; }

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
.error { color: #dc2626; font-size: 12.5px; padding: 0 4px 8px; display: none; }
.error.on { display: block; }
.brand { text-align: center; font-size: 11px; color: var(--wk-muted); padding-top: 8px; }
.brand a { color: inherit; text-decoration: none; font-weight: 600; }

@keyframes wk-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes wk-twinkle { 0%, 84%, 100% { transform: none; } 90% { transform: rotate(90deg) scale(1.18); } 95% { transform: rotate(90deg) scale(.96); } }
@keyframes wk-sheen { 0%, 80% { background-position: 150% 0; } 100% { background-position: -50% 0; } }
@keyframes wk-think { 0% { transform: rotate(0) scale(1); } 50% { transform: rotate(180deg) scale(.72); } 100% { transform: rotate(360deg) scale(1); } }
@keyframes wk-ring { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--wk-accent) 55%, transparent); } 100% { box-shadow: 0 0 0 9px transparent; } }
@keyframes wk-pop { 0% { transform: scale(.4) rotate(-90deg); opacity: 0; } 70% { transform: scale(1.15) rotate(10deg); opacity: 1; } 100% { transform: none; } }
@keyframes wk-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: .5; } 30% { transform: translateY(-4px); opacity: 1; } }

@media (max-width: 480px) {
  .panel { inset: 0; width: 100%; height: 100%; border-radius: 0; border: 0; }
  .wk.open .launcher { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .launcher, .panel, .row, .system, .chip, .send, .launcher svg, .glow, .hero { transition: none !important; animation: none !important; }
  .typing i, .avatar, .avatar svg, .avatar::after, .mini svg, .mini::after { animation: none !important; }
}
`;

const ICONS = {
  chat: `<svg class="ic-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>`,
  close: `<svg class="ic-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>`,
  x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.4 3.6a2 2 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
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
  private sendBtn!: HTMLButtonElement;
  private errorEl!: HTMLElement;
  private badge!: HTMLElement;
  private conv: { id: string; token: string } | null = null;
  private source: EventSource | null = null;
  private seen = new Set<number>();
  private lastId = 0;
  private lastAuthor: string | null = null;
  private unread = 0;
  private media = window.matchMedia?.("(prefers-color-scheme: dark)");

  constructor(options: InitOptions) {
    options = defined(options);
    const apiUrl = (options.apiUrl ?? (scriptSrc ? new URL(scriptSrc).origin : location.origin)).replace(/\/$/, "");
    this.opts = {
      title: "Help & feedback",
      subtitle: "Ask, report a problem or share an idea",
      greeting: "Ask a question, report something that's not working, or share an idea.",
      welcomeSubtitle: "How can we help you today?",
      placeholder: "Write a message…",
      launcherLabel: "",
      suggestions: ["I have a question", "Something's not working", "I have an idea"],
      showBranding: true,
      ...options,
      apiUrl,
    };
    this.theme = { mode: "auto", position: "right", ...defined(options.theme ?? {}) };
    if (options.accentColor && !this.theme.accentColor) this.theme.accentColor = options.accentColor;

    const host = document.createElement("div");
    host.setAttribute("data-wicket", "");
    document.body.appendChild(host);
    this.root = host.attachShadow({ mode: "open" });
    this.render();
    this.applyTheme();
    this.media?.addEventListener?.("change", () => this.applyTheme());
    this.conv = this.loadStored();
    if (this.conv) this.connect();
  }

  open() {
    this.wrap.classList.add("open");
    this.halftone.play();
    this.setUnread(0);
    setTimeout(() => this.input.focus(), 50);
  }

  close() {
    this.wrap.classList.remove("open");
    this.halftone.pause();
  }

  toggle() {
    this.wrap.classList.contains("open") ? this.close() : this.open();
  }

  setUser(user: User) {
    this.opts.user = user;
    this.renderWelcome();
  }

  setContext(context: Record<string, unknown>) {
    this.opts.context = { ...(this.opts.context ?? {}), ...context };
  }

  setTheme(theme: Theme) {
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
    const first = this.opts.user?.name?.trim().split(/\s+/)[0];
    this.wrap.querySelector(".hello")!.textContent = this.opts.welcomeTitle ?? `Hi${first ? ` ${first}` : ""} 👋`;
  }

  private avatarHtml(cls = "avatar") {
    return `<div class="${cls}">${this.opts.logoUrl ? `<img alt="" src="${escapeAttr(this.opts.logoUrl)}">` : ICONS.spark}</div>`;
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
          <form class="field">
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
    this.input = this.wrap.querySelector("textarea")!;
    this.sendBtn = this.wrap.querySelector(".send")!;

    this.typing = document.createElement("div");
    this.typing.className = "typing";
    this.typing.innerHTML = `${this.avatarHtml("mini")}<div class="msg" aria-label="Typing"><i></i><i></i><i></i></div>`;
    this.chips = document.createElement("div");
    this.chips.className = "chips";

    launcher.addEventListener("click", () => this.toggle());
    this.wrap.querySelector(".x")!.addEventListener("click", () => this.close());
    this.wrap.querySelector(".new")!.addEventListener("click", () => this.reset());
    this.wrap.querySelector(".hist")!.addEventListener("click", () =>
      this.wrap.classList.contains("list") ? this.reset() : void this.showHistory(),
    );
    this.wrap.querySelector("form")!.addEventListener("submit", (e) => {
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
    this.wrap.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
    this.showGreeting();
  }

  private autosize() {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 140)}px`;
    this.sendBtn.disabled = !this.input.value.trim();
  }

  private showGreeting() {
    this.wrap.classList.add("home");
    this.log.innerHTML = "";
    this.lastAuthor = null;
    this.log.appendChild(this.typing);
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
    if (this.chips.childElementCount) this.log.insertBefore(this.chips, this.typing);
    void this.showRecent();
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
    el.innerHTML = `<span class="ct">${escapeHtml(c.title || "Conversation")}</span><span class="cw">${c.status === "resolved" ? "Resolved · " : ""}${timeAgo(c.updatedAt)}</span>
      <span class="cl">${who ? `<b>${escapeHtml(who)}:</b> ` : ""}${escapeHtml(c.last?.body ?? "")}</span>`;
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
    this.chips.remove();
    this.log.innerHTML = "";
    this.log.appendChild(this.typing);
    this.wrap.classList.remove("home", "list");
    this.connect();
    this.input.focus();
  }

  private async summaries(): Promise<Summary[]> {
    const conversations = this.loadList();
    if (!conversations.length) return [];
    try {
      const res = await fetch(`${this.opts.apiUrl}/api/conversations/summaries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversations }),
      });
      if (!res.ok) return [];
      const list = ((await res.json()).conversations ?? []) as Summary[];
      // Forget conversations the server no longer knows (e.g. after a database reset).
      const known = new Set(list.map((x) => x.id));
      this.saveList(conversations.filter((x) => known.has(x.id)));
      return list;
    } catch {
      return [];
    }
  }

  private reset() {
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

  private async send() {
    const body = this.input.value.trim();
    if (!body || this.input.disabled) return;
    this.input.disabled = true;
    this.sendBtn.disabled = true;
    this.showError("");
    this.leaveHome();
    try {
      if (!this.conv) {
        const res = await this.api("/api/conversations", { reporter: this.opts.user ?? {}, context: this.collectContext() });
        this.conv = { id: res.id, token: res.token };
        this.store();
        this.saveList([this.conv, ...this.loadList()]);
        this.connect();
      }
      this.input.value = "";
      this.autosize();
      const { message } = await this.api(`/api/conversations/${this.conv.id}/messages`, {
        body,
        context: { page: location.href },
      });
      this.appendBubble(message);
    } catch (err) {
      this.input.value = this.input.value || body;
      this.showError(err instanceof Error ? err.message : "Couldn't send. Please try again.");
    } finally {
      this.input.disabled = false;
      this.autosize();
      this.input.focus();
    }
  }

  private connect() {
    if (!this.conv || this.source) return;
    const url = `${this.opts.apiUrl}/api/conversations/${this.conv.id}/events?token=${encodeURIComponent(this.conv.token)}&after=${this.lastId}`;
    const es = new EventSource(url);
    this.source = es;
    es.addEventListener("message", (e) => {
      const m = JSON.parse((e as MessageEvent).data).message as Message;
      const fresh = !this.seen.has(m.id);
      this.appendBubble(m);
      if (fresh && m.author !== "user" && !this.wrap.classList.contains("open") && Date.now() - m.createdAt < 60_000) {
        this.setUnread(this.unread + 1);
      }
    });
    es.addEventListener("typing", () => {
      this.typing.classList.add("on");
      this.wrap.classList.add("thinking");
      this.scrollDown();
    });
    es.addEventListener("idle", () => {
      this.typing.classList.remove("on");
      this.wrap.classList.remove("thinking");
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
      this.wrap.classList.remove("thinking");
    }

    if (m.author === "system") {
      const el = document.createElement("div");
      el.className = "system";
      el.textContent = m.body;
      this.log.insertBefore(el, this.typing);
      this.lastAuthor = "system";
      this.scrollDown();
      return;
    }

    const groupKey = `${m.author}:${m.authorName ?? ""}`;
    const continued = this.lastAuthor === groupKey;
    this.lastAuthor = groupKey;

    const row = document.createElement("div");
    row.className = `row ${m.author}${continued ? "" : " gap"}`;
    let avatar = "";
    if (m.author === "agent") avatar = this.avatarHtml(`mini${continued ? " hidden" : ""}`);
    if (m.author === "staff") {
      avatar = `<div class="mini staff${continued ? " hidden" : ""}">${escapeHtml(initials(m.authorName))}</div>`;
    }
    const who =
      m.author === "staff" && !continued
        ? `<div class="who">${escapeHtml(m.authorName ?? "Team")}<span class="tag">Team</span></div>`
        : "";
    row.innerHTML = `${avatar}<div class="col">${who}<div class="msg">${renderMarkdown(m.body)}</div></div>`;
    this.log.insertBefore(row, this.typing);
    this.scrollDown();
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
    return `wicket:${this.opts.apiUrl}:${this.opts.user?.id ?? "anon"}`;
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

/** Drops undefined keys so they don't override defaults when spread. */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function timeAgo(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 604800) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

/** Minimal, safe markdown: escape everything, then allow links, bold and inline code. */
export function renderMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
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
