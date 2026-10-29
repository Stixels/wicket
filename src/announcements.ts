import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { announced } from "./db/schema.js";

/**
 * Posts each new item of an RSS feed (for example the product's Updates page) to a Discord
 * announcement channel. The first check only remembers what the feed already holds, so turning it
 * on never floods the channel with old posts. An item is remembered once its post succeeds, so a
 * failed post is tried again on the next check.
 */

export interface FeedItem {
  id: string;
  title: string;
  link: string;
  summary: string;
  /** The item's lead image (media:content or an image enclosure), when it has one. */
  image: string | null;
  publishedAt: Date | null;
}

/** At most this many posts per check, newest kept, if the feed jumps ahead (say after downtime). */
const MAX_POSTS_PER_CHECK = 5;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(text: string): string {
  const cdata = text.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1].trim();
  return text
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
      if (name[0] === "#") {
        const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .trim();
}

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
}

function imageUrl(xml: string): string | null {
  for (const [el] of xml.matchAll(/<(?:media:content|media:thumbnail|enclosure)\b[^>]*>/gi)) {
    const url = el.match(/\burl="([^"]+)"/i)?.[1];
    const type = el.match(/\btype="([^"]+)"/i)?.[1];
    const medium = el.match(/\bmedium="([^"]+)"/i)?.[1];
    if (url && (medium === "image" || type?.startsWith("image/") || /^<media:thumbnail/i.test(el))) return decode(url);
  }
  return null;
}

/** The items of an RSS 2.0 feed, in feed order. Items with no link or guid are skipped. */
export function parseRss(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  for (const [, body] of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const link = tag(body, "link");
    const id = tag(body, "guid") || link;
    if (!id) continue;
    const date = new Date(tag(body, "pubDate"));
    items.push({
      id,
      title: tag(body, "title") || "Update",
      link,
      summary: tag(body, "description"),
      image: imageUrl(body),
      publishedAt: Number.isNaN(date.getTime()) ? null : date,
    });
  }
  return items;
}

/** A Discord message for one item: a linked title, the summary and the date. */
export function announcementMessage(item: FeedItem, color?: number) {
  return {
    embeds: [
      {
        title: item.title.slice(0, 256),
        ...(item.link ? { url: item.link } : {}),
        ...(item.summary ? { description: item.summary.slice(0, 4096) } : {}),
        ...(item.image ? { image: { url: item.image } } : {}),
        ...(item.publishedAt ? { timestamp: item.publishedAt.toISOString() } : {}),
        ...(color !== undefined ? { color } : {}),
      },
    ],
  };
}

export interface AnnouncerOptions {
  feedUrl: string;
  /** Sends one message to the channel. Throws when Discord refuses it. */
  post: (message: ReturnType<typeof announcementMessage>) => Promise<void>;
  color?: number;
  fetch?: typeof fetch;
  log?: (msg: string, err?: unknown) => void;
}

export class Announcer {
  constructor(
    private db: Db,
    private o: AnnouncerOptions,
  ) {}

  /** Fetches the feed and posts what's new. Returns how many items it posted. */
  async check(): Promise<number> {
    const res = await (this.o.fetch ?? fetch)(this.o.feedUrl, { headers: { accept: "application/rss+xml, application/xml;q=0.9" } });
    if (!res.ok) throw new Error(`feed answered ${res.status}`);
    const items = parseRss(await res.text());
    const feed = this.o.feedUrl;
    const seen = new Set(this.db.select({ id: announced.itemId }).from(announced).where(eq(announced.feed, feed)).all().map((r) => r.id));

    const fresh = items.filter((item) => !seen.has(item.id));
    if (!fresh.length) return 0;
    if (!seen.size) {
      this.remember(fresh);
      this.o.log?.(`announcements: following ${feed}; ${fresh.length} existing ${fresh.length === 1 ? "post" : "posts"} left unannounced`);
      return 0;
    }

    // Oldest first, so the channel reads in order. Only the newest few if many arrived at once.
    const byDate = [...fresh].sort((a, b) => (a.publishedAt?.getTime() ?? 0) - (b.publishedAt?.getTime() ?? 0));
    const skipped = byDate.slice(0, -MAX_POSTS_PER_CHECK);
    if (skipped.length) this.remember(skipped);
    let posted = 0;
    for (const item of byDate.slice(-MAX_POSTS_PER_CHECK)) {
      await this.o.post(announcementMessage(item, this.o.color));
      this.remember([item]);
      posted++;
    }
    return posted;
  }

  private remember(items: FeedItem[]) {
    const now = new Date();
    for (const item of items) {
      this.db
        .insert(announced)
        .values({ feed: this.o.feedUrl, itemId: item.id, createdAt: now })
        .onConflictDoNothing()
        .run();
    }
  }

}
