import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { Announcer, parseRss, type announcementMessage } from "../src/announcements.js";

const FEED = "https://example.com/updates/rss.xml";

const rss = (items: { slug: string; title: string; date: string; summary?: string; image?: string }[]) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Updates</title>
${items
  .map(
    (i) => `<item>
  <title>${i.title}</title>
  <link>https://example.com/updates/${i.slug}</link>
  <guid isPermaLink="true">https://example.com/updates/${i.slug}</guid>
  <pubDate>${new Date(`${i.date}T00:00:00Z`).toUTCString()}</pubDate>
  <description>${i.summary ?? "Summary."}</description>
  ${i.image ? `<media:content url="${i.image}" medium="image"/>` : ""}
</item>`,
  )
  .join("\n")}
</channel></rss>`;

function setup(body: { current: string }, fail?: { current: boolean }, latest?: number) {
  const posted: ReturnType<typeof announcementMessage>[] = [];
  const announcer = new Announcer(openDb(":memory:"), {
    feedUrl: FEED,
    latest,
    fetch: (async () => new Response(body.current)) as typeof fetch,
    post: async (message) => {
      if (fail?.current) throw new Error("Discord said no");
      posted.push(message);
    },
  });
  return { announcer, posted };
}

describe("announcements", () => {
  it("reads titles, links, dates and summaries, decoding entities", () => {
    const [item] = parseRss(
      rss([{ slug: "a", title: "Clues &amp; hints", date: "2026-10-20", summary: "Faster &lt;Clues&gt;.", image: "https://example.com/a.webp?w=1&amp;h=2" }]),
    );
    expect(item).toEqual({
      id: "https://example.com/updates/a",
      title: "Clues & hints",
      link: "https://example.com/updates/a",
      summary: "Faster <Clues>.",
      image: "https://example.com/a.webp?w=1&h=2",
      publishedAt: new Date("2026-10-20T00:00:00Z"),
    });
  });

  it("posts nothing the first time, then each new item once", async () => {
    const body = { current: rss([{ slug: "old", title: "Old", date: "2026-09-01" }]) };
    const { announcer, posted } = setup(body);

    expect(await announcer.check()).toBe(0);
    expect(posted).toEqual([]);

    body.current = rss([
      { slug: "new", title: "Assistant", date: "2026-10-20", summary: "Ask a question from any page.", image: "https://example.com/hero.webp" },
      { slug: "old", title: "Old", date: "2026-09-01" },
    ]);
    expect(await announcer.check()).toBe(1);
    expect(posted[0].embeds[0]).toMatchObject({
      title: "Assistant",
      url: "https://example.com/updates/new",
      description: "Ask a question from any page.",
      timestamp: "2026-10-20T00:00:00.000Z",
      image: { url: "https://example.com/hero.webp" },
    });

    expect(await announcer.check()).toBe(0);
    expect(posted).toHaveLength(1);
  });

  it("posts several new items oldest first", async () => {
    const body = { current: rss([{ slug: "a", title: "A", date: "2026-09-01" }]) };
    const { announcer, posted } = setup(body);
    await announcer.check();

    body.current = rss([
      { slug: "c", title: "C", date: "2026-10-20" },
      { slug: "b", title: "B", date: "2026-10-01" },
      { slug: "a", title: "A", date: "2026-09-01" },
    ]);
    await announcer.check();
    expect(posted.map((m) => m.embeds[0].title)).toEqual(["B", "C"]);
  });

  it("tries a failed post again on the next check", async () => {
    const body = { current: rss([{ slug: "a", title: "A", date: "2026-09-01" }]) };
    const fail = { current: false };
    const { announcer, posted } = setup(body, fail);
    await announcer.check();

    body.current = rss([
      { slug: "b", title: "B", date: "2026-10-01" },
      { slug: "a", title: "A", date: "2026-09-01" },
    ]);
    fail.current = true;
    await expect(announcer.check()).rejects.toThrow("Discord said no");

    fail.current = false;
    expect(await announcer.check()).toBe(1);
    expect(posted.map((m) => m.embeds[0].title)).toEqual(["B"]);
  });

  it("with latest: 1, posts the newest existing item once, then only new ones", async () => {
    const body = {
      current: rss([
        { slug: "b", title: "B", date: "2026-10-01" },
        { slug: "a", title: "A", date: "2026-09-01" },
      ]),
    };
    const { announcer, posted } = setup(body, undefined, 1);

    expect(await announcer.check()).toBe(1);
    expect(await announcer.check()).toBe(0);
    expect(posted.map((m) => m.embeds[0].title)).toEqual(["B"]);

    body.current = rss([
      { slug: "c", title: "C", date: "2026-10-20" },
      { slug: "b", title: "B", date: "2026-10-01" },
      { slug: "a", title: "A", date: "2026-09-01" },
    ]);
    expect(await announcer.check()).toBe(1);
    expect(posted.map((m) => m.embeds[0].title)).toEqual(["B", "C"]);
  });

  it("with latest: 1 added later, posts the newest item that was only recorded", async () => {
    const db = openDb(":memory:");
    const body = rss([{ slug: "a", title: "A", date: "2026-09-01" }]);
    const posted: string[] = [];
    const make = (latest?: number) =>
      new Announcer(db, {
        feedUrl: FEED,
        latest,
        fetch: (async () => new Response(body)) as typeof fetch,
        post: async (m) => void posted.push(m.embeds[0].title),
      });

    expect(await make().check()).toBe(0);
    expect(await make(1).check()).toBe(1);
    expect(await make(1).check()).toBe(0);
    expect(posted).toEqual(["A"]);
  });
});
