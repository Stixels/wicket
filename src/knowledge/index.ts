import type { Db } from "../db/index.js";
import type { DocSection, KnowledgeSource } from "../adapters/types.js";

export interface SearchHit {
  title: string;
  heading: string;
  url: string;
  snippet: string;
}

/** Replaces the whole index in one transaction so searches never see a half-built index. */
export function replaceIndex(db: Db, sections: DocSection[]): void {
  const sqlite = db.$client;
  const insert = sqlite.prepare("INSERT INTO docs (title, heading, url, body) VALUES (?, ?, ?, ?)");
  sqlite.transaction(() => {
    sqlite.exec("DELETE FROM docs");
    for (const s of sections) insert.run(s.title, s.heading, s.url, s.body);
  })();
}

export async function reindex(db: Db, sources: KnowledgeSource[]): Promise<number> {
  const all: DocSection[] = [];
  for (const source of sources) all.push(...(await source.load()));
  replaceIndex(db, all);
  return all.length;
}

export function searchDocs(db: Db, query: string, limit = 5): SearchHit[] {
  const terms = query
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((t) => t.length > 1)
    .slice(0, 12);
  if (!terms?.length) return [];
  // OR the terms (quoted so FTS syntax in user text can't break the query); bm25 ranks
  // sections matching more and rarer terms first, with titles and headings weighted up.
  const match = terms.map((t) => `"${t}"`).join(" OR ");
  return db.$client
    .prepare(
      `SELECT title, heading, url, snippet(docs, 3, '', '', ' … ', 48) AS snippet
       FROM docs WHERE docs MATCH ? ORDER BY bm25(docs, 5.0, 3.0, 0.0, 1.0) LIMIT ?`,
    )
    .all(match, limit) as SearchHit[];
}

const MAX_READ_CHARS = 24_000;

/** The full text behind a search result: one section by its link, or a whole page by its link without "#". */
export function readDoc(db: Db, url: string): string | null {
  // A link with "#" is one section; without, the page's intro plus all its sections.
  const rows = (
    url.includes("#")
      ? db.$client.prepare("SELECT title, heading, body FROM docs WHERE url = ?").all(url)
      : db.$client
          .prepare("SELECT title, heading, body FROM docs WHERE url = ? OR url LIKE ? ESCAPE '\\' ORDER BY rowid")
          .all(url, `${url.replace(/[\\%_]/g, "\\$&")}#%`)
  ) as Pick<DocSection, "title" | "heading" | "body">[];
  if (!rows.length) return null;
  const text = rows.map((r, i) => `${i === 0 ? `# ${r.title}\n` : ""}${r.heading ? `## ${r.heading}\n` : ""}${r.body}`).join("\n\n");
  return text.length > MAX_READ_CHARS ? `${text.slice(0, MAX_READ_CHARS)}\n… (truncated)` : text;
}
