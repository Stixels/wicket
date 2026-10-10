/**
 * Feedback Loop widget. Add to any web app:
 *
 *   <script src="https://YOUR-SERVER/widget.js" defer></script>
 *   <script>
 *     window.addEventListener("load", () => FeedbackLoop.init({
 *       user: { id: "u_123", name: "Sam", email: "sam@example.com" },
 *       context: { appVersion: "1.4.2", plan: "pro" },
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

interface InitOptions {
  apiUrl?: string;
  user?: User;
  context?: Record<string, unknown>;
  title?: string;
  greeting?: string;
  accentColor?: string;
  /** Hide the floating button and open the panel yourself with FeedbackLoop.open(). */
  hideLauncher?: boolean;
}

interface Message {
  id: number;
  author: "user" | "agent" | "staff" | "system";
  authorName: string | null;
  body: string;
  createdAt: number;
}

const scriptSrc = (document.currentScript as HTMLScriptElement | null)?.src;
const scriptEl = document.currentScript as HTMLScriptElement | null;

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
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.launcher { position: fixed; right: 20px; bottom: 20px; width: 56px; height: 56px; border-radius: 50%;
  border: none; background: var(--accent); color: #fff; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.25);
  display: flex; align-items: center; justify-content: center; z-index: 2147483000; }
.launcher svg { width: 26px; height: 26px; }
.panel { position: fixed; right: 20px; bottom: 88px; width: 370px; max-width: calc(100vw - 32px);
  height: 540px; max-height: calc(100vh - 120px); background: #fff; color: #1a1a1a; border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0,0,0,.25); display: none; flex-direction: column; overflow: hidden; z-index: 2147483000; }
.panel.open { display: flex; }
.head { background: var(--accent); color: #fff; padding: 14px 16px; display: flex; align-items: center; gap: 8px; }
.head .title { font-weight: 600; font-size: 15px; flex: 1; }
.head button { background: transparent; border: none; color: #fff; cursor: pointer; font-size: 13px; opacity: .85; }
.head button:hover { opacity: 1; }
.log { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 10px; background: #f7f7f8; }
.msg { max-width: 85%; padding: 9px 12px; border-radius: 12px; font-size: 14px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }
.msg a { color: inherit; text-decoration: underline; }
.msg.user { align-self: flex-end; background: var(--accent); color: #fff; border-bottom-right-radius: 4px; }
.msg.agent, .msg.staff { align-self: flex-start; background: #fff; border: 1px solid #e6e6e9; border-bottom-left-radius: 4px; }
.msg.system { align-self: center; background: transparent; color: #6b6b73; font-size: 12px; text-align: center; }
.who { font-size: 11px; color: #6b6b73; margin-bottom: 2px; }
.typing { align-self: flex-start; color: #6b6b73; font-size: 13px; padding: 4px 2px; display: none; }
.typing.on { display: block; }
form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #e6e6e9; background: #fff; }
textarea { flex: 1; resize: none; border: 1px solid #d8d8dd; border-radius: 10px; padding: 9px 10px; font-size: 14px;
  min-height: 40px; max-height: 120px; outline: none; color: #1a1a1a; background: #fff; }
textarea:focus { border-color: var(--accent); }
.send { border: none; background: var(--accent); color: #fff; border-radius: 10px; padding: 0 14px; font-size: 14px; cursor: pointer; }
.send:disabled { opacity: .5; cursor: default; }
.error { color: #b42318; font-size: 12px; padding: 0 12px 8px; display: none; background: #fff; }
.error.on { display: block; }
@media (prefers-color-scheme: dark) {
  .panel { background: #1c1c1f; color: #ececf1; }
  .log { background: #141416; }
  .msg.agent, .msg.staff { background: #232327; border-color: #333338; color: #ececf1; }
  form, .error { background: #1c1c1f; border-color: #333338; }
  textarea { background: #232327; color: #ececf1; border-color: #3a3a40; }
}
`;

const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;

class FeedbackWidget {
  private opts: Required<Pick<InitOptions, "apiUrl" | "title" | "greeting" | "accentColor">> & InitOptions;
  private root: ShadowRoot;
  private panel!: HTMLElement;
  private log!: HTMLElement;
  private typing!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private errorEl!: HTMLElement;
  private conv: { id: string; token: string } | null = null;
  private source: EventSource | null = null;
  private seen = new Set<number>();
  private lastId = 0;

  constructor(options: InitOptions) {
    const apiUrl = (options.apiUrl ?? (scriptSrc ? new URL(scriptSrc).origin : location.origin)).replace(/\/$/, "");
    this.opts = {
      title: "Help & feedback",
      greeting: "Hi! Ask a question, report a problem or share an idea. I'll point you to the right answer or get it to the team.",
      accentColor: "#4f46e5",
      ...options,
      apiUrl,
    };
    const host = document.createElement("div");
    host.setAttribute("data-feedback-loop", "");
    document.body.appendChild(host);
    this.root = host.attachShadow({ mode: "open" });
    this.render();
    this.conv = this.loadStored();
  }

  open() {
    this.panel.classList.add("open");
    if (this.conv) this.connect();
    setTimeout(() => this.input.focus(), 0);
  }

  close() {
    this.panel.classList.remove("open");
  }

  setUser(user: User) {
    this.opts.user = user;
  }

  setContext(context: Record<string, unknown>) {
    this.opts.context = { ...(this.opts.context ?? {}), ...context };
  }

  private render() {
    const style = document.createElement("style");
    style.textContent = CSS;
    const wrap = document.createElement("div");
    wrap.style.setProperty("--accent", this.opts.accentColor);
    wrap.innerHTML = `
      <button class="launcher" aria-label="Open help and feedback">${ICON}</button>
      <section class="panel" role="dialog" aria-label="${escapeHtml(this.opts.title)}">
        <div class="head"><span class="title">${escapeHtml(this.opts.title)}</span>
          <button class="new" title="Start a new conversation">New</button>
          <button class="x" aria-label="Close">✕</button></div>
        <div class="log" aria-live="polite"></div>
        <div class="error"></div>
        <form><textarea rows="1" placeholder="Type your message…" aria-label="Message"></textarea>
          <button class="send" type="submit">Send</button></form>
      </section>`;
    this.root.append(style, wrap);

    const launcher = wrap.querySelector<HTMLButtonElement>(".launcher")!;
    if (this.opts.hideLauncher) launcher.style.display = "none";
    this.panel = wrap.querySelector(".panel")!;
    this.log = wrap.querySelector(".log")!;
    this.errorEl = wrap.querySelector(".error")!;
    this.input = wrap.querySelector("textarea")!;
    this.sendBtn = wrap.querySelector(".send")!;
    this.typing = document.createElement("div");
    this.typing.className = "typing";
    this.typing.textContent = "Thinking…";

    launcher.addEventListener("click", () => (this.panel.classList.contains("open") ? this.close() : this.open()));
    wrap.querySelector(".x")!.addEventListener("click", () => this.close());
    wrap.querySelector(".new")!.addEventListener("click", () => this.reset());
    wrap.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.send();
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send();
      }
    });
    this.input.addEventListener("input", () => {
      this.input.style.height = "auto";
      this.input.style.height = `${Math.min(this.input.scrollHeight, 120)}px`;
    });
    this.showGreeting();
  }

  private showGreeting() {
    this.log.innerHTML = "";
    this.log.appendChild(this.typing);
    this.appendBubble({ id: 0, author: "agent", authorName: null, body: this.opts.greeting, createdAt: Date.now() });
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
    this.showGreeting();
    this.input.focus();
  }

  private async send() {
    const body = this.input.value.trim();
    if (!body || this.sendBtn.disabled) return;
    this.sendBtn.disabled = true;
    this.showError("");
    try {
      if (!this.conv) {
        const res = await this.api("/api/conversations", {
          reporter: this.opts.user ?? {},
          context: this.collectContext(),
        });
        this.conv = { id: res.id, token: res.token };
        this.store();
        this.connect();
      }
      this.input.value = "";
      this.input.style.height = "auto";
      const { message } = await this.api(`/api/conversations/${this.conv.id}/messages`, {
        body,
        context: { page: location.href },
      });
      this.appendBubble(message);
    } catch (err) {
      this.input.value = this.input.value || body;
      this.showError(err instanceof Error ? err.message : "Couldn't send. Please try again.");
    } finally {
      this.sendBtn.disabled = false;
    }
  }

  private connect() {
    if (!this.conv || this.source) return;
    const url = `${this.opts.apiUrl}/api/conversations/${this.conv.id}/events?token=${encodeURIComponent(this.conv.token)}&after=${this.lastId}`;
    const es = new EventSource(url);
    this.source = es;
    es.addEventListener("message", (e) => this.appendBubble(JSON.parse((e as MessageEvent).data).message));
    es.addEventListener("typing", () => this.typing.classList.add("on"));
    es.addEventListener("idle", () => this.typing.classList.remove("on"));
    es.addEventListener("error", () => {
      // A 404 means the conversation is gone (e.g. database reset): start fresh.
      if (es.readyState === EventSource.CLOSED) {
        this.source = null;
        fetch(url, { method: "GET" })
          .then((r) => r.status === 404 && this.reset())
          .catch(() => {});
      }
    });
  }

  private appendBubble(m: Message) {
    if (m.id && this.seen.has(m.id)) return;
    if (m.id) {
      this.seen.add(m.id);
      this.lastId = Math.max(this.lastId, m.id);
    }
    if (m.author !== "user") this.typing.classList.remove("on");
    const el = document.createElement("div");
    el.className = `msg ${m.author}`;
    if (m.author === "staff") {
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = m.authorName ? `${m.authorName} · Team` : "Team";
      el.appendChild(who);
    }
    const body = document.createElement("div");
    body.innerHTML = renderMarkdown(m.body);
    el.appendChild(body);
    this.log.insertBefore(el, this.typing);
    this.log.scrollTop = this.log.scrollHeight;
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
    return `feedback-loop:${this.opts.apiUrl}:${this.opts.user?.id ?? "anon"}`;
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
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Minimal, safe markdown: escape everything, then allow links, bold and inline code. */
export function renderMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

let instance: FeedbackWidget | null = null;
const api = {
  init(options: InitOptions = {}) {
    if (!instance) instance = new FeedbackWidget(options);
    return api;
  },
  open: () => instance?.open(),
  close: () => instance?.close(),
  setUser: (user: User) => instance?.setUser(user),
  setContext: (context: Record<string, unknown>) => instance?.setContext(context),
};
(window as any).FeedbackLoop = api;

if (scriptEl?.hasAttribute("data-auto-init")) {
  const start = () => api.init({ apiUrl: scriptEl.dataset.apiUrl, accentColor: scriptEl.dataset.accentColor });
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", start) : start();
}
