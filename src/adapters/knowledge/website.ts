import type { DocSection, KnowledgeSource } from "../types.js";
import { splitMarkdown } from "./markdownRepo.js";

export interface WebsiteOptions {
  /** Docs home page (pages under its path are indexed) or a sitemap.xml URL. */
  url: string;
  /** Stop after this many pages. */
  maxPages?: number;
  fetchImpl?: typeof fetch;
}

const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|css|js|json|xml|txt|mp4|webm|woff2?)$/i;

/**
 * Indexes a hosted docs site (GitBook, Mintlify, Docusaurus, a help center, ...) when there's
 * no repo to read. Finds pages from the sitemap, or by following links from the start page.
 */
export class WebsiteSource implements KnowledgeSource {
  name: string;
  private start: URL;
  private scope: string; // only pages whose path starts with this

  constructor(private opts: WebsiteOptions) {
    this.start = new URL(opts.url);
    this.name = `web:${this.start.host}`;
    const isSitemap = /\.xml$/i.test(this.start.pathname);
    this.scope = isSitemap ? "/" : this.start.pathname.replace(/\/?$/, "/");
  }

  async load(): Promise<DocSection[]> {
    const max = this.opts.maxPages ?? 500;
    const fromSitemap = await this.sitemapUrls(/\.xml$/i.test(this.start.pathname) ? this.start.href : `${this.start.origin}/sitemap.xml`);
    const pages = new Map<string, string>(); // url -> html

    if (fromSitemap.length) {
      const urls = fromSitemap.filter((u) => this.inScope(u)).slice(0, max);
      await each(urls, 4, async (u) => {
        const html = await this.getHtml(u);
        if (html) pages.set(u, html);
      });
    } else {
      // No sitemap: follow links breadth first from the start page.
      const queue = [this.normalize(this.start.href)!];
      const seen = new Set(queue);
      while (queue.length && pages.size < max) {
        const batch = queue.splice(0, 4);
        await each(batch, 4, async (u) => {
          const html = await this.getHtml(u);
          if (!html) return;
          pages.set(u, html);
          for (const href of links(html, u)) {
            const n = this.normalize(href);
            if (n && !seen.has(n) && this.inScope(n)) {
              seen.add(n);
              queue.push(n);
            }
          }
        });
      }
    }
    if (!pages.size) throw new Error(`No pages found at ${this.opts.url}`);
    return [...pages].flatMap(([url, html]) => splitMarkdown(htmlToMarkdown(html), url));
  }

  private async sitemapUrls(url: string, depth = 0): Promise<string[]> {
    const res = await this.fetch(url).catch(() => null);
    if (!res?.ok) return [];
    const xml = await res.text();
    const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]!));
    if (/<sitemapindex/i.test(xml) && depth < 2) {
      const nested = await Promise.all(locs.map((l) => this.sitemapUrls(l, depth + 1)));
      return nested.flat();
    }
    return locs.map((l) => this.normalize(l)).filter((l): l is string => Boolean(l));
  }

  private inScope(url: string): boolean {
    const u = new URL(url);
    return u.host === this.start.host && `${u.pathname.replace(/\/?$/, "/")}`.startsWith(this.scope) && !SKIP_EXT.test(u.pathname);
  }

  private normalize(href: string): string | null {
    try {
      const u = new URL(href, this.start);
      if (!/^https?:$/.test(u.protocol)) return null;
      u.hash = "";
      u.search = "";
      return u.href.replace(/\/$/, "") || u.href;
    } catch {
      return null;
    }
  }

  private async getHtml(url: string): Promise<string | null> {
    const res = await this.fetch(url).catch(() => null);
    if (!res?.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
    return res.text();
  }

  private fetch(url: string) {
    return (this.opts.fetchImpl ?? fetch)(url, { headers: { "User-Agent": "wicket (docs indexer)", Accept: "text/html,application/xml" }, redirect: "follow" });
  }
}

async function each<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

function links(html: string, base: string): string[] {
  return [...html.matchAll(/<a\s[^>]*href=["']([^"'#][^"']*)["']/gi)].map((m) => {
    try {
      return new URL(decodeEntities(m[1]!), base).href;
    } catch {
      return "";
    }
  });
}

/** Rough HTML to markdown: keeps the main content's headings, lists, code and paragraphs. */
export function htmlToMarkdown(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, "");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1];
  const main = /<main[\s>][\s\S]*<\/main>/i.exec(s)?.[0] ?? /<article[\s>][\s\S]*<\/article>/i.exec(s)?.[0] ?? /<body[\s>][\s\S]*<\/body>/i.exec(s)?.[0] ?? s;
  s = main
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|button)[\s>][\s\S]*?<\/\1>/gi, "")
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, code: string) => `\n\`\`\`\n${decodeEntities(code.replace(/<[^>]+>/g, "")).trim()}\n\`\`\`\n`)
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, t: string) => `\n# ${inline(t)}\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, t: string) => `\n## ${inline(t)}\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, t: string) => `\n### ${inline(t)}\n`)
    .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, (_, t: string) => `\n**${inline(t)}**\n`)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, t: string) => `\`${t}\``)
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/ul|\/ol|\/table|\/section|\/blockquote)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Pages without an h1 take the <title>, minus a " | Site name" suffix.
  if (!/^#\s/m.test(s) && title) s = `# ${inline(title).split(/\s[|–—-]\s/)[0]}\n\n${s}`;
  return s;
}

function inline(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").replace(/[#¶]\s*$/, "").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}
