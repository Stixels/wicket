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
  start(onStaffReply: (reply: StaffReply) => Promise<void>): Promise<void>;
  /** Creates the team-side thread for a conversation; returns its id. */
  openThread(conversation: RelayConversation, firstMessage: string): Promise<string>;
  post(threadId: string, author: "user" | "agent" | "system", body: string): Promise<void>;
  /** Flags a thread as needing a person (mention a role, tag the post, ...). */
  requestHuman(threadId: string, reason: string): Promise<void>;
  stop(): Promise<void>;
}
