import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

// Kept as plain SQL so a fresh volume works with no migration step.
// The FTS5 table backs docs search and has no Drizzle equivalent.
const BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'agent',
  reporter_id TEXT,
  reporter_name TEXT,
  reporter_email TEXT,
  user_id TEXT,
  plan TEXT,
  payer TEXT,
  context TEXT,
  relay_thread_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_relay_thread ON conversations(relay_thread_id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  author TEXT NOT NULL,
  author_name TEXT,
  body TEXT NOT NULL,
  attachments TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS agent_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_turns_conversation ON agent_turns(conversation_id, id);

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  payer TEXT NOT NULL,
  profile TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_payer ON usage(payer, created_at);
CREATE INDEX IF NOT EXISTS usage_created ON usage(created_at);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id INTEGER,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS files_conversation ON files(conversation_id);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  discord_id TEXT UNIQUE,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS saved_replies (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS team_sessions (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  tracker TEXT NOT NULL,
  ref TEXT NOT NULL,
  key TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  checked_at INTEGER,
  closed_at INTEGER
);

CREATE TABLE IF NOT EXISTS ticket_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  summary TEXT,
  created_at INTEGER NOT NULL,
  notified_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_links_pair ON ticket_links(ticket_id, conversation_id);
CREATE INDEX IF NOT EXISTS ticket_links_conversation ON ticket_links(conversation_id);

CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
  title, heading, url UNINDEXED, body,
  tokenize = 'porter unicode61'
);
`;

export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(BOOTSTRAP);
  addMissingColumns(sqlite, "conversations", {
    user_id: "TEXT",
    plan: "TEXT",
    payer: "TEXT",
    seen_message_id: "INTEGER",
    emailed_message_id: "INTEGER",
    emailed_at: "INTEGER",
    email_opt_out: "INTEGER",
    last_seen_at: "INTEGER",
  });
  addMissingColumns(sqlite, "messages", { attachments: "TEXT", member_id: "TEXT", mentions: "TEXT", event: "TEXT" });
  addMissingColumns(sqlite, "files", { deleted_at: "INTEGER" });
  return drizzle(sqlite, { schema }) as Db;
}

/** Columns added after a table first shipped; existing databases get them on boot. */
function addMissingColumns(sqlite: Database.Database, table: string, columns: Record<string, string>) {
  const have = new Set((sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  for (const [name, type] of Object.entries(columns)) {
    if (!have.has(name)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

export { schema };
