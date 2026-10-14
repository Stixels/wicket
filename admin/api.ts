/** Shapes the dashboard API returns (src/team/routes.ts). */

export interface Member {
  id: string;
  name: string;
  avatarUrl: string | null;
  discordId: string | null;
}

export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
  expired?: boolean;
}

export type Author = "user" | "agent" | "staff" | "system" | "note";
export type Status = "agent" | "needs_human" | "human" | "resolved";

export interface Message {
  id: number;
  author: Author;
  authorName: string | null;
  body: string;
  attachments: Attachment[];
  createdAt: number;
  memberId: string | null;
  mentions: string[];
}

export interface InboxItem {
  id: string;
  status: Status;
  title: string;
  reporter: { name: string | null; email: string | null; plan: string | null; signedIn: boolean };
  last: { author: Author; authorName: string | null; body: string; createdAt: number } | null;
  updatedAt: number;
  participants: { memberId: string | null; name: string }[];
  needsReply: boolean;
  mentionsMe: boolean;
  discordUrl: string | null;
  presence: Presence;
}

export interface Presence {
  state: "viewing" | "online" | "offline";
  lastSeenAt: number | null;
}

export interface LinkedTicket {
  key: string;
  url: string;
  title: string;
  state: "open" | "done" | "closed";
  relation: "filed" | "added";
  notified: boolean;
}

export interface ConversationDetail extends InboxItem {
  context: Record<string, unknown> | null;
  createdAt: number;
  /** Tickets this conversation filed or was added to. */
  tickets?: LinkedTicket[];
}

export type View = "open" | "needs_reply" | "mentions" | "resolved" | "all";

export type TeamEvent =
  | { type: "message"; conversationId: string; message: Message; who?: string | null; status?: Status }
  | { type: "status"; conversationId: string; status: Status; who?: string | null }
  | { type: "typing"; conversationId: string; memberId: string | null; name: string; source: string }
  | { type: "presence"; conversationId: string; presence: Presence };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data: any,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; json?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(`/admin${path}`, {
    method: init.method ?? (init.json !== undefined || init.form ? "POST" : "GET"),
    headers: init.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data);
  return data as T;
}

export const fileUrl = (a: Attachment) => `/files/${a.id}/${encodeURIComponent(a.name)}`;
