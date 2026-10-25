import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Parser, type ReadEntry } from "tar";
import type { DocSection, KnowledgeSource } from "../types.js";

/** Files that describe the repo for contributors, not users. */
const SKIP = /(^|\/)(AGENTS|CLAUDE|CONTEXT|CONTRIBUTING|CHANGELOG|LICENSE)\.md$|(^|\/)\.|(^|\/)node_modules\//i;

export interface MarkdownRepoOptions {
  repo: string; // "owner/repo"
  ref?: string;
  token?: string;
  /** Public docs site. Paths map to `${baseUrl}/${path without .md or .mdx}` (README or index -> folder). */
  baseUrl?: string;
  /** Files to index, as globs ("**\/*.md", "examples/**\/*.ino"). Markdown and MDX only when left out. */
  include?: string[];
  /** Globs to skip, on top of contributor files like AGENTS.md and CONTRIBUTING.md. */
  exclude?: string[];
  fetchImpl?: typeof fetch;
}

/** Code files are indexed whole, as one fenced block, so an example can be read in full. */
const CODE_LANG: Record<string, string> = { ino: "cpp", h: "cpp", hpp: "cpp", c: "c", cpp: "cpp", py: "python", js: "js", ts: "ts", json: "json", yaml: "yaml", yml: "yaml" };
const MAX_CODE_CHARS = 20_000;

/** "**" matches across folders, "*" within one. A pattern without a slash matches the file name anywhere. */
export function globToRegex(glob: string): RegExp {
  const g = glob.includes("/") ? glob.replace(/^\//, "") : `**/${glob}`;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*" && g[i + 1] === "*") {
      re += g[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += g[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

const MARKDOWN = /\.(md|mdx|markdown)$/i;

/**
 * Reads every markdown file from a GitHub repo in one tarball request.
 * Works for GitBook Git Sync, Mintlify and most static docs repos. A Mintlify
 * `.mintignore` keeps repo-only files (contributor notes, decision records) out.
 */
export class MarkdownRepoSource implements KnowledgeSource {
  name: string;
  constructor(private opts: MarkdownRepoOptions) {
    this.name = `github:${opts.repo}`;
  }

  async load(): Promise<DocSection[]> {
    const { repo, ref = "HEAD", token } = this.opts;
    const doFetch = this.opts.fetchImpl ?? fetch;
    const res = await doFetch(`https://api.github.com/repos/${repo}/tarball/${ref}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "wicket",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok || !res.body) throw new Error(`Fetching ${repo} failed: ${res.status}`);

    const include = (this.opts.include ?? ["**/*.md", "**/*.mdx"]).map(globToRegex);
    const exclude = (this.opts.exclude ?? []).map(globToRegex);
    const wanted = (rel: string) =>
      rel === ".mintignore" || (include.some((r) => r.test(rel)) && !exclude.some((r) => r.test(rel)) && !SKIP.test(rel));
    const files: { path: string; text: string }[] = [];
    const parser = new Parser({
      filter: (p: string) => wanted(p.split("/").slice(1).join("/")),
      onReadEntry: (entry: ReadEntry) => {
        const chunks: Buffer[] = [];
        entry.on("data", (c: Buffer) => chunks.push(c));
        entry.on("end", () => {
          // Tarball paths start with "<owner>-<repo>-<sha>/".
          const rel = entry.path.split("/").slice(1).join("/");
          if (rel && wanted(rel)) files.push({ path: rel, text: Buffer.concat(chunks).toString("utf8") });
        });
      },
    });
    await pipeline(Readable.fromWeb(res.body as any), createGunzip(), parser);

    const mintignore = files.find((f) => f.path === ".mintignore");
    const ignored = mintignore ? ignoreRules(mintignore.text) : [];
    return files
      .filter((f) => f !== mintignore && !/(^|\/)SUMMARY\.md$/i.test(f.path) && !ignored.some((r) => r.test(f.path)))
      .flatMap((f) => (MARKDOWN.test(f.path) ? splitMarkdown(f.text, this.urlFor(f.path)) : [this.codeSection(f.path, f.text)]));
  }

  private codeSection(file: string, text: string): DocSection {
    const ext = file.split(".").pop()!.toLowerCase();
    const code = text.length > MAX_CODE_CHARS ? `${text.slice(0, MAX_CODE_CHARS)}\n// … (truncated)` : text;
    return { title: file, heading: "", url: this.githubUrl(file), body: `\`\`\`${CODE_LANG[ext] ?? ""}\n${code.trimEnd()}\n\`\`\`` };
  }

  private githubUrl(file: string): string {
    return `https://github.com/${this.opts.repo}/blob/${this.opts.ref ?? "HEAD"}/${file}`;
  }

  private urlFor(file: string): string {
    const page = file.replace(/(^|\/)(README|index)\.mdx?$/i, "$1").replace(MARKDOWN, "").replace(/\/$/, "");
    if (this.opts.baseUrl) return `${this.opts.baseUrl.replace(/\/$/, "")}/${page}`.replace(/\/$/, "");
    return this.githubUrl(file);
  }
}

/** `.mintignore` lines, gitignore style: "docs/" skips a folder, "README.md" a file anywhere. */
function ignoreRules(text: string): RegExp[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
    .map((l) => globToRegex(l.endsWith("/") ? `${l}**` : l));
}

/** Splits a page into sections at ## / ### headings so search returns focused snippets. */
export function splitMarkdown(markdown: string, url: string): DocSection[] {
  const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  const text = markdown
    .slice(frontMatter ? frontMatter[0].length : 0)
    .replace(/^import\s.+\sfrom\s+["'].*$/gm, "") // MDX imports
    .replace(/^export\s+(const|let|function|default)\b.*$/gm, "") // MDX exports
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ""); // MDX comments
  const lines = text.split("\n");
  // Mintlify pages carry the title in front matter instead of a # heading.
  const fmTitle = /^title:\s*["']?(.*?)["']?\s*$/m.exec(frontMatter?.[1] ?? "")?.[1];
  const title = (lines.find((l) => /^#\s/.test(l)) ?? "").replace(/^#\s+/, "").trim() || fmTitle || url;

  const sections: DocSection[] = [];
  let heading = "";
  let buf: string[] = [];
  const flush = () => {
    const body = cleanBody(buf.join("\n"));
    if (body && !isNavigation(heading, body)) sections.push({ title, heading, url: heading ? `${url}#${slug(heading)}` : url, body });
    buf = [];
  };
  for (const line of lines) {
    const m = /^(##|###)\s+(.*)$/.exec(line);
    if (m) {
      flush();
      heading = m[2].trim();
    } else if (!/^#\s/.test(line)) {
      buf.push(line);
    }
  }
  flush();
  return sections;
}

/** "Next" / "See also" blocks are just links to other pages and crowd out real answers. */
function isNavigation(heading: string, body: string): boolean {
  if (/^(next|next steps|see also|related|related pages)$/i.test(heading)) return true;
  return body.replace(/\[[^\]]*\]\([^)]*\)/g, "").replace(/[\s*>-]/g, "").length === 0;
}

function cleanBody(s: string): string {
  return s
    .replace(/\{%.*?%\}/g, "") // GitBook template tags
    .replace(/<[^>]+>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
}
