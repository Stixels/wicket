import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * status:
 *  - "agent": the agent answers
 *  - "needs_human": the agent asked for a person; it stays quiet until someone replies
 *  - "human": a team member replied in the relay; the agent stays quiet
 *  - "resolved": the team closed it; the next user message hands it back to the agent
 */
export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull(),
    status: text("status", { enum: ["agent", "needs_human", "human", "resolved"] }).notNull().default("agent"),
    reporterId: text("reporter_id"),
    reporterName: text("reporter_name"),
    reporterEmail: text("reporter_email"),
    /** Set only from a valid signed user token. */
    userId: text("user_id"),
    plan: text("plan"),
    /** Who the assistant's spend counts against: "user:<id>" or "visitor:<hash of IP>". */
    payer: text("payer"),
    context: text("context", { mode: "json" }).$type<Record<string, unknown>>(),
    relayThreadId: text("relay_thread_id"),
    /** The newest message the widget has shown the user. Replies past it are unread. */
    seenMessageId: integer("seen_message_id"),
    /** The newest team reply already sent by email, and when. */
    emailedMessageId: integer("emailed_message_id"),
    emailedAt: integer("emailed_at", { mode: "timestamp_ms" }),
    /** The user asked for no more emails about this conversation. */
    emailOptOut: integer("email_opt_out", { mode: "boolean" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("conversations_relay_thread").on(t.relayThreadId)],
);

/**
 * What people see: the user, the agent and the team. "note" is team-only (a handoff or
 * an aside) and never reaches the user.
 */
export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: text("conversation_id").notNull(),
    author: text("author", { enum: ["user", "agent", "staff", "system", "note"] }).notNull(),
    authorName: text("author_name"),
    /** The teammate who wrote a staff reply or note, wherever they wrote it. */
    memberId: text("member_id"),
    /** Teammates a note @mentions. */
    mentions: text("mentions", { mode: "json" }).$type<string[]>(),
    body: text("body").notNull(),
    attachments: text("attachments", { mode: "json" }).$type<{ id: string; name: string; type: string; size: number; expired?: boolean }[]>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("messages_conversation").on(t.conversationId, t.id)],
);

/**
 * The model's own transcript, stored exactly as sent and received so it can be
 * replayed unchanged (append-only; thinking blocks must not be edited).
 */
export const agentTurns = sqliteTable(
  "agent_turns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: text("conversation_id").notNull(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content", { mode: "json" }).notNull().$type<unknown>(),
  },
  (t) => [index("agent_turns_conversation").on(t.conversationId, t.id)],
);

/** What each assistant response cost, for budgets. Kept when a conversation is deleted. */
export const usage = sqliteTable(
  "usage",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: text("conversation_id").notNull(),
    payer: text("payer").notNull(),
    profile: text("profile").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    costMicros: integer("cost_micros").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("usage_payer").on(t.payer, t.createdAt), index("usage_created").on(t.createdAt)],
);

/** Attachments. The bytes live in the file store; this is what they are and where they belong. */
export const files = sqliteTable(
  "files",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    messageId: integer("message_id"),
    name: text("name").notNull(),
    type: text("type").notNull(),
    size: integer("size").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    /** Set when the bytes were removed (expired or deleted by the team). The row stays as a record. */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("files_conversation").on(t.conversationId)],
);

/**
 * One row per teammate, whichever tool they reply from. A reply from Discord and one from
 * the dashboard by the same person point at the same member.
 */
export const members = sqliteTable("members", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  discordId: text("discord_id").unique(),
  avatarUrl: text("avatar_url"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
});

/** Dashboard sign-ins. Only a hash of the cookie is stored. */
export const teamSessions = sqliteTable("team_sessions", {
  id: text("id").primaryKey(),
  memberId: text("member_id").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});
