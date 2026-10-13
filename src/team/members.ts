import crypto from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";

export type Member = typeof schema.members.$inferSelect;

export interface PublicMember {
  id: string;
  name: string;
  avatarUrl: string | null;
  discordId: string | null;
}

const SESSION_DAYS = 30;

/** Teammates, linked across tools by their ids there, and their dashboard sessions. */
export class Members {
  constructor(private db: Db) {}

  get(id: string): Member | undefined {
    return this.db.select().from(schema.members).where(eq(schema.members.id, id)).get();
  }

  byDiscordId(discordId: string): Member | undefined {
    return this.db.select().from(schema.members).where(eq(schema.members.discordId, discordId)).get();
  }

  list(): PublicMember[] {
    return this.db
      .select()
      .from(schema.members)
      .all()
      .map(toPublicMember)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Finds the teammate with this Discord id, or adds them; keeps their name and picture current. */
  upsertDiscord(discordId: string, name: string, avatarUrl?: string | null): Member {
    const existing = this.byDiscordId(discordId);
    const clean = name.trim().slice(0, 100) || "Team";
    if (existing) {
      if (existing.name === clean && (avatarUrl === undefined || existing.avatarUrl === avatarUrl)) return existing;
      return this.db
        .update(schema.members)
        .set({ name: clean, ...(avatarUrl !== undefined ? { avatarUrl } : {}) })
        .where(eq(schema.members.id, existing.id))
        .returning()
        .get()!;
    }
    return this.db
      .insert(schema.members)
      .values({ id: crypto.randomUUID(), name: clean, discordId, avatarUrl: avatarUrl ?? null, createdAt: new Date() })
      .returning()
      .get();
  }

  /** A teammate with no linked tool, e.g. the local dev sign-in. */
  upsertLocal(id: string, name: string): Member {
    const existing = this.get(id);
    if (existing) return existing;
    return this.db.insert(schema.members).values({ id, name, createdAt: new Date() }).returning().get();
  }

  /** Starts a dashboard session and returns the cookie value. */
  createSession(memberId: string): string {
    const token = crypto.randomBytes(32).toString("base64url");
    this.db.delete(schema.teamSessions).where(lt(schema.teamSessions.expiresAt, new Date())).run();
    this.db
      .insert(schema.teamSessions)
      .values({ id: hashToken(token), memberId, expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) })
      .run();
    return token;
  }

  /** The signed-in teammate for a session cookie, if it is still valid. */
  fromSession(token: string | undefined): Member | null {
    if (!token) return null;
    const session = this.db.select().from(schema.teamSessions).where(eq(schema.teamSessions.id, hashToken(token))).get();
    if (!session || session.expiresAt.getTime() < Date.now()) return null;
    const member = this.get(session.memberId);
    if (member && (!member.lastSeenAt || Date.now() - member.lastSeenAt.getTime() > 60_000)) {
      this.db.update(schema.members).set({ lastSeenAt: new Date() }).where(eq(schema.members.id, member.id)).run();
    }
    return member ?? null;
  }

  endSession(token: string | undefined) {
    if (token) this.db.delete(schema.teamSessions).where(eq(schema.teamSessions.id, hashToken(token))).run();
  }
}

export function toPublicMember(m: Member): PublicMember {
  return { id: m.id, name: m.name, avatarUrl: m.avatarUrl, discordId: m.discordId };
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("base64url");
}
