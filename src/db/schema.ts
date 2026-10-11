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
    context: text("context", { mode: "json" }).$type<Record<string, unknown>>(),
    relayThreadId: text("relay_thread_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [index("conversations_relay_thread").on(t.relayThreadId)],
);

/** What people see: the user, the agent and the team. */
export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: text("conversation_id").notNull(),
    author: text("author", { enum: ["user", "agent", "staff", "system"] }).notNull(),
    authorName: text("author_name"),
    body: text("body").notNull(),
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
