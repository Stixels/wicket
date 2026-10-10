import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { create } from "tar";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { replaceIndex, searchDocs } from "../src/knowledge/index.js";
import { MarkdownRepoSource, splitMarkdown } from "../src/adapters/knowledge/markdownRepo.js";

describe("splitMarkdown", () => {
  it("splits a page into sections with anchored links and strips GitBook tags", () => {
    const sections = splitMarkdown(
      `---\ndescription: x\n---\n# Configure Live View\nIntro text.\n\n## Add a timer\n{% hint style="info" %}\nTimers count down.\n{% endhint %}\n\n### Timer colors\nPick a color.\n`,
      "https://docs.example.com/build/live-view",
    );
    expect(sections.map((s) => [s.heading, s.url])).toEqual([
      ["", "https://docs.example.com/build/live-view"],
      ["Add a timer", "https://docs.example.com/build/live-view#add-a-timer"],
      ["Timer colors", "https://docs.example.com/build/live-view#timer-colors"],
    ]);
    expect(sections[1].body).toBe("Timers count down.");
    expect(sections.every((s) => s.title === "Configure Live View")).toBe(true);
  });
});

describe("searchDocs", () => {
  const db = openDb(":memory:");
  replaceIndex(db, [
    { title: "Configure Live View", heading: "Add a timer", url: "u1", body: "Timers count down on the player screen." },
    { title: "Manage Game Masters", heading: "Invite a game master", url: "u2", body: "Send an invite from settings." },
    { title: "Billing", heading: "", url: "u3", body: "Change your plan in account settings." },
  ]);

  it("ranks the section that matches the question first", () => {
    expect(searchDocs(db, "How do I add a timer to the live view?")[0].url).toBe("u1");
    expect(searchDocs(db, "invite another game master")[0].url).toBe("u2");
  });

  it("treats FTS syntax in user text as plain words", () => {
    expect(() => searchDocs(db, 'timer" OR NEAR(* -) AND')).not.toThrow();
    expect(searchDocs(db, "???")).toEqual([]);
  });
});

describe("MarkdownRepoSource", () => {
  it("reads markdown files from a GitHub tarball and maps them to docs URLs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fl-"));
    const root = path.join(dir, "acme-docs-abc123");
    fs.mkdirSync(path.join(root, "run-a-session"), { recursive: true });
    fs.writeFileSync(path.join(root, "README.md"), "# Welcome\nStart here.");
    fs.writeFileSync(path.join(root, "SUMMARY.md"), "# Table of contents\n* [x](x.md)");
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# Agent notes\nnot for users");
    fs.writeFileSync(path.join(root, "run-a-session", "README.md"), "# Run a Session\nOverview.");
    fs.writeFileSync(path.join(root, "run-a-session", "troubleshoot.md"), "# Troubleshoot\n## Screen is blank\nRefresh it.");
    const tarball = path.join(dir, "repo.tgz");
    await create({ gzip: true, file: tarball, cwd: dir }, ["acme-docs-abc123"]);

    let requested = "";
    const fetchImpl = (async (url: string) => {
      requested = url;
      return new Response(Readable.toWeb(fs.createReadStream(tarball)) as any, { status: 200 });
    }) as typeof fetch;

    const source = new MarkdownRepoSource({ repo: "acme/docs", baseUrl: "https://docs.acme.com/", fetchImpl });
    const sections = await source.load();

    expect(requested).toBe("https://api.github.com/repos/acme/docs/tarball/HEAD");
    expect(sections.map((s) => s.url).sort()).toEqual([
      "https://docs.acme.com",
      "https://docs.acme.com/run-a-session",
      "https://docs.acme.com/run-a-session/troubleshoot#screen-is-blank",
    ]);
  });
});

describe("navigation sections", () => {
  it("drops link-only sections like Next", () => {
    const sections = splitMarkdown("# Page\nReal intro text here.\n\n## Next\n\n[Other page](other.md)\n", "u");
    expect(sections.map((s) => s.heading)).toEqual([""]);
  });
});
