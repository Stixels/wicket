import type { Member, TeamEvent } from "./api.js";

/**
 * Desktop notifications for the things that need a person: a user waiting on the team, a user
 * writing in a conversation the team has, and a note that mentions you. Nothing while you're
 * looking at the dashboard; the tab title counts what you missed instead.
 */

const KEY = "wicket-team-notify";
const baseTitle = document.title;
let missed = 0;

export const supported = typeof window !== "undefined" && "Notification" in window;

export function wanted(): boolean {
  try {
    return localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function enabled(): boolean {
  return supported && wanted() && Notification.permission === "granted";
}

/** Turns notifications on (asking the browser if needed) or off. Returns whether they're on. */
export async function setEnabled(on: boolean): Promise<boolean> {
  if (on && supported && Notification.permission === "default") await Notification.requestPermission();
  const ok = on && supported && Notification.permission === "granted";
  try {
    localStorage.setItem(KEY, ok ? "on" : "off");
  } catch {}
  return ok;
}

/** Whether the person has decided either way, so the dashboard stops offering. */
export function decided(): boolean {
  try {
    return localStorage.getItem(KEY) !== null || (supported && Notification.permission === "denied");
  } catch {
    return true;
  }
}

export function dismiss() {
  try {
    localStorage.setItem(KEY, "off");
  } catch {}
}

/** What to say about an event, if anything. */
export function describe(event: TeamEvent, me: Member): { title: string; body: string } | null {
  if (event.type === "status" && event.status === "needs_human") {
    return { title: `${event.who ?? "A visitor"} is waiting for the team`, body: "The assistant passed this conversation to you." };
  }
  if (event.type !== "message") return null;
  const m = event.message;
  const text = m.body || (m.attachments[0] ? `📎 ${m.attachments[0].name}` : "");
  if (m.author === "user" && (event.status === "needs_human" || event.status === "human")) {
    return { title: event.who ?? "New message", body: text };
  }
  if (m.author === "note" && m.mentions.includes(me.id) && m.memberId !== me.id) {
    return { title: `${m.authorName ?? "A teammate"} mentioned you`, body: text };
  }
  return null;
}

export function notify(event: TeamEvent, me: Member, onOpen: (conversationId: string) => void) {
  const what = describe(event, me);
  if (!what) return;
  const looking = document.visibilityState === "visible" && document.hasFocus();
  if (looking) return;
  missed++;
  document.title = `(${missed}) ${baseTitle}`;
  if (!enabled()) return;
  const n = new Notification(what.title, {
    body: what.body.slice(0, 180),
    tag: event.conversationId, // a newer one replaces the older for the same conversation
    icon: (document.querySelector("link[rel=icon]") as HTMLLinkElement | null)?.href,
  });
  n.onclick = () => {
    window.focus();
    onOpen(event.conversationId);
    n.close();
  };
}

function seen() {
  missed = 0;
  document.title = baseTitle;
}
addEventListener("focus", seen);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && document.hasFocus() && seen());
