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
  return drizzle(sqlite, { schema }) as Db;
}

export { schema };
