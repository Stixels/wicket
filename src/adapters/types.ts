/**
 * The core only talks to these interfaces. Each tool a team already uses
 * (GitBook, Linear, Discord, Slack, ...) plugs in as one adapter.
 */

/** A section of documentation, ready to index. */
export interface DocSection {
  title: string; // page title
  heading: string; // section heading within the page ("" for the intro)
  url: string; // public link a user can open
  body: string; // plain-ish markdown text
}

/** Supplies documentation to index. */
export interface KnowledgeSource {
  name: string;
  load(): Promise<DocSection[]>;
}

export interface RelayConversation {
  id: string;
  reporterName: string | null;
  reporterEmail: string | null;
  context: Record<string, unknown> | null;
  relayThreadId: string | null;
}

export interface StaffReply {
  threadId: string;
  authorName: string;
  body: string;
}

/** Mirrors conversations into the team's chat tool and brings replies back. */
export interface Relay {
  name: string;
  /** onResolved returns true when the conversation wasn't resolved yet. `deleted` means the thread is gone. */
  start(onStaffReply: (reply: StaffReply) => Promise<void>, onResolved?: (threadId: string, deleted?: boolean) => Promise<boolean>): Promise<void>;
  /** Creates the team-side thread for a conversation; returns its id. */
  openThread(conversation: RelayConversation, firstMessage: string): Promise<string>;
  post(threadId: string, author: "user" | "agent" | "system", body: string, authorName?: string | null): Promise<void>;
  /** Flags a thread as needing a person (mention a role, tag the post, ...). */
  requestHuman(threadId: string, reason: string): Promise<void>;
  /** Shows that the assistant is working (e.g. "is typing…"). Optional. */
  typing?(threadId: string): Promise<void>;
  /** Marks the team-side thread resolved after the team closed it. Optional. */
  markResolved?(threadId: string): Promise<void>;
  /** Clears the resolved state when the user writes again. Optional. */
  reopen?(threadId: string): Promise<void>;
  stop(): Promise<void>;
}

export type TicketKind = "bug" | "feature" | "improvement" | "docs" | "question";

export interface TicketDraft {
  title: string;
  description: string; // markdown
  kind: TicketKind;
}

/** Where tickets go (Linear, GitHub Issues, Jira, ...). */
export interface Tracker {
  name: string;
  create(ticket: TicketDraft): Promise<{ key: string; url: string }>;
}

/** Thrown by a relay when the team deleted a conversation's thread. */
export class ThreadGoneError extends Error {
  constructor(public threadId: string) {
    super(`thread ${threadId} no longer exists`);
    this.name = "ThreadGoneError";
  }
}
