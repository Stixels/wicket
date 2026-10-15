import { MarkdownRepoSource } from "../adapters/knowledge/markdownRepo.js";
import { WebsiteSource } from "../adapters/knowledge/website.js";
import type { KnowledgeSource } from "../adapters/types.js";
import type { Config } from "../config.js";
import type { Settings } from "../settings.js";

/** The docs the assistant searches: the main docs from env, plus `knowledge:` from settings. */
export function knowledgeSources(config: Config, settings: Settings): KnowledgeSource[] {
  const sources: KnowledgeSource[] = [];
  if (config.DOCS_GITHUB_REPO) {
    sources.push(
      new MarkdownRepoSource({
        repo: config.DOCS_GITHUB_REPO,
        ref: config.DOCS_GITHUB_REF,
        token: config.DOCS_GITHUB_TOKEN,
        baseUrl: config.DOCS_BASE_URL,
      }),
    );
  }
  if (config.DOCS_URL) sources.push(new WebsiteSource({ url: config.DOCS_URL }));
  for (const k of settings.knowledge) {
    sources.push(
      "url" in k
        ? new WebsiteSource({ url: k.url, maxPages: k.maxPages })
        : new MarkdownRepoSource({ repo: k.github, ref: k.ref, baseUrl: k.baseUrl, include: k.include, exclude: k.exclude, token: config.DOCS_GITHUB_TOKEN }),
    );
  }
  return sources;
}
