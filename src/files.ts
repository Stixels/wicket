import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { schema, type Db } from "./db/index.js";

/** What a message carries about each file; the bytes stay in the file store. */
export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
  /** The file was removed; the message keeps its name so the conversation still reads right. */
  expired?: boolean;
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // Discord's upload limit without boosts
/** Uploads that never made it into a message (closed tab, removed before sending). */
const UNSENT_KEEP_MS = 24 * 60 * 60 * 1000;
export const MAX_FILES_PER_CONVERSATION = 30;

/**
 * File types people can attach. Nothing that a browser would run (HTML, SVG), so serving
 * a file from our domain can't execute anything.
 */
const ALLOWED = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/json",
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "application/zip",
]);

/** Shown in the browser rather than downloaded. */
export const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "video/mp4", "video/webm", "video/quicktime"]);

/** Images the model can look at (its limit is 5 MB per image). */
export const MODEL_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_MODEL_IMAGE_BYTES = 5 * 1024 * 1024;

export function allowedType(type: string): boolean {
  return ALLOWED.has(type.split(";")[0]!.trim().toLowerCase());
}

/** Keeps the original name readable but harmless in a header or a path. */
export function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const clean = base.replace(/[\u0000-\u001f"<>|*?:]/g, "").replace(/\s+/g, " ").trim();
  return (clean || "file").slice(0, 120);
}

/**
 * Stores attachments on disk next to the database (a Railway volume in production).
 * Ids are random and unguessable; knowing one is what lets someone open the file.
 */
export class FileStore {
  readonly dir: string;

  constructor(
    private db: Db,
    databasePath: string,
  ) {
    this.dir = databasePath === ":memory:" ? fs.mkdtempSync(path.join(os.tmpdir(), "wicket-files-")) : path.join(path.dirname(databasePath), "files");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  save(conversationId: string, name: string, type: string, data: Buffer): Attachment {
    const file: Attachment = {
      id: crypto.randomBytes(18).toString("base64url"),
      name: cleanName(name),
      type: type.split(";")[0]!.trim().toLowerCase(),
      size: data.length,
    };
    fs.writeFileSync(path.join(this.dir, file.id), data);
    this.db
      .insert(schema.files)
      .values({ ...file, conversationId, messageId: null, createdAt: new Date() })
      .run();
    return file;
  }

  get(id: string) {
    if (!/^[\w-]{10,64}$/.test(id)) return null;
    return this.db.select().from(schema.files).where(and(eq(schema.files.id, id), isNull(schema.files.deletedAt))).get() ?? null;
  }

  read(id: string): Buffer | null {
    if (!this.get(id)) return null;
    try {
      return fs.readFileSync(path.join(this.dir, id));
    } catch {
      return null;
    }
  }

  countFor(conversationId: string): number {
    return this.db
      .select()
      .from(schema.files)
      .where(and(eq(schema.files.conversationId, conversationId), isNull(schema.files.deletedAt)))
      .all().length;
  }

  /** Marks uploaded files as part of a message. Only unclaimed files from the same conversation count. */
  claim(conversationId: string, ids: string[], messageId: number): Attachment[] {
    if (!ids.length) return [];
    const rows = this.db
      .select()
      .from(schema.files)
      .where(and(eq(schema.files.conversationId, conversationId), inArray(schema.files.id, ids), isNull(schema.files.messageId), isNull(schema.files.deletedAt)))
      .all();
    if (!rows.length) return [];
    this.db
      .update(schema.files)
      .set({ messageId })
      .where(inArray(schema.files.id, rows.map((r) => r.id)))
      .run();
    // Keep the order the person attached them in.
    return ids.flatMap((id) => rows.filter((r) => r.id === id)).map(({ id, name, type, size }) => ({ id, name, type, size }));
  }

  /**
   * Removes a file's bytes and marks it expired on its message. Returns the message id it was on,
   * if any, so callers can tell people watching the conversation.
   */
  remove(id: string): { messageId: number | null } | null {
    const row = this.get(id);
    if (!row) return null;
    this.drop([row]);
    return { messageId: row.messageId };
  }

  /**
   * Removes attachments older than keepDays (0 keeps them) and uploads that were never sent.
   * Returns how many files went.
   */
  sweep(keepDays: number, now = Date.now()): number {
    const unsent = and(isNull(schema.files.messageId), lt(schema.files.createdAt, new Date(now - UNSENT_KEEP_MS)));
    const old = keepDays > 0 ? and(isNotNull(schema.files.messageId), lt(schema.files.createdAt, new Date(now - keepDays * 86_400_000))) : undefined;
    const rows = this.db
      .select()
      .from(schema.files)
      .where(and(isNull(schema.files.deletedAt), old ? or(unsent, old) : unsent))
      .all();
    this.drop(rows);
    return rows.length;
  }

  /** Deletes every file of these conversations, bytes and records, for good. */
  erase(conversationIds: string[]) {
    if (!conversationIds.length) return;
    const rows = this.db.select().from(schema.files).where(inArray(schema.files.conversationId, conversationIds)).all();
    for (const r of rows) fs.rmSync(path.join(this.dir, r.id), { force: true });
    this.db.delete(schema.files).where(inArray(schema.files.conversationId, conversationIds)).run();
  }

  private drop(rows: (typeof schema.files.$inferSelect)[]) {
    if (!rows.length) return;
    for (const r of rows) fs.rmSync(path.join(this.dir, r.id), { force: true });
    this.db
      .update(schema.files)
      .set({ deletedAt: new Date() })
      .where(inArray(schema.files.id, rows.map((r) => r.id)))
      .run();
    // Keep the name on the message, flagged, so the conversation still makes sense.
    const gone = new Set(rows.map((r) => r.id));
    const messageIds = [...new Set(rows.flatMap((r) => (r.messageId == null ? [] : [r.messageId])))];
    if (!messageIds.length) return;
    for (const m of this.db.select().from(schema.messages).where(inArray(schema.messages.id, messageIds)).all()) {
      const attachments = (m.attachments ?? []).map((a) => (gone.has(a.id) ? { ...a, expired: true } : a));
      this.db.update(schema.messages).set({ attachments }).where(eq(schema.messages.id, m.id)).run();
    }
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
