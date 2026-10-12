import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { schema, type Db } from "./db/index.js";

/** What a message carries about each file; the bytes stay in the file store. */
export interface Attachment {
  id: string;
  name: string;
  type: string;
  size: number;
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // Discord's upload limit without boosts
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
    return this.db.select().from(schema.files).where(eq(schema.files.id, id)).get() ?? null;
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
    return this.db.select().from(schema.files).where(eq(schema.files.conversationId, conversationId)).all().length;
  }

  /** Marks uploaded files as part of a message. Only unclaimed files from the same conversation count. */
  claim(conversationId: string, ids: string[], messageId: number): Attachment[] {
    if (!ids.length) return [];
    const rows = this.db
      .select()
      .from(schema.files)
      .where(and(eq(schema.files.conversationId, conversationId), inArray(schema.files.id, ids), isNull(schema.files.messageId)))
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
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
