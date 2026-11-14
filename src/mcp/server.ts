import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ConversationService } from "../conversations.js";
import type { Db } from "../db/index.js";
import type { Identity } from "../identity.js";
import { readDoc, searchDocs } from "../knowledge/index.js";
import type { ReportKind } from "../settings.js";

/** Who's calling. Over HTTP it's whoever the identity token names; over stdio, whoever runs it. */
export interface McpCaller {
  identity: Identity;
  /** What an anonymous person's spend and limits count against, like the widget's IP. */
  visitorKey: string;
  /** Rate limits, shared with the widget where they mean the same thing. False means over the limit. */
  allow: { call(): boolean; report(): boolean };
  /** Which app is calling, when the transport knows (e.g. from the User-Agent). Else the handshake's client name. */
  client?: string | null;
}

export interface McpDeps {
  service: ConversationService;
  db: Db;
  productName: string;
  /** For absolute links to tickets and chats. */
  publicUrl?: string | null;
  /** Longest search query or report description; the demo keeps these as short as its chat messages. */
  maxTextLength?: number;
  /** The wicket package version, for the server's info. */
  version?: string;
}

const TOO_MANY = "Too many requests, try again later.";

/**
 * Wicket's tools for MCP clients: the docs the assistant answers from, the tracker reports go to,
 * and where each report stands. The caller's own model does the talking, so these spend nothing
 * from the assistant's budgets. One server per caller, so the tools and report kinds on offer are
 * exactly what the caller's profile allows.
 */
export function createMcpServer(deps: McpDeps, caller: McpCaller): McpServer {
  const { service, db } = deps;
  const { identity } = caller;
  const profile = service.profileFor({ userId: identity.id, plan: identity.plan, context: null });
  const kinds = service.reportsFor(profile, "mcp");
  const desk = service.tickets;
  const hearsBack = Boolean(desk?.canFollow);
  const absolute = (url: string) => (url.startsWith("/") && deps.publicUrl ? `${deps.publicUrl.replace(/\/$/, "")}${url}` : url);

  const server = new McpServer(
    { name: "wicket", title: `${deps.productName} support`, version: deps.version ?? "1.0.0" },
    {
      instructions: [
        `Support for ${deps.productName}, from Wicket.`,
        "Use search_docs to answer questions from the product's docs, and read_doc for the full text behind a result. Link the sections you used.",
        kinds.length
          ? `To report ${kinds.map((k) => (k === "bug" ? "a bug" : "a feature request")).join(" or ")}, use file_report. Gather what the team needs first, and confirm with the user before filing. It checks for an existing ticket and may ask you to pick one.`
          : "Reports can't be filed from this account.",
        "Use ticket_status to see where someone's reports stand and what the team said.",
      ].join(" "),
    },
  );

  server.registerTool(
    "search_docs",
    {
      title: "Search the docs",
      description: `Search ${deps.productName}'s documentation. Returns the best-matching sections with a snippet and link each. Use read_doc on a link for its full text before answering from it.`,
      inputSchema: {
        query: z.string().min(1).max(500).describe("Keywords or a question"),
        limit: z.number().int().min(1).max(10).optional().describe("How many sections, 5 by default"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      if (!caller.allow.call()) return fail(TOO_MANY);
      if (deps.maxTextLength && query.length > deps.maxTextLength) return fail(`Queries can be up to ${deps.maxTextLength} characters here.`);
      const hits = searchDocs(db, query, limit ?? 5);
      if (!hits.length) return ok("No docs sections match. Try other words.", { results: [] });
      const text = hits.map((h, i) => `${i + 1}. ${h.heading ? `${h.title} › ${h.heading}` : h.title}\n   ${h.url}\n   ${h.snippet.replace(/\s+/g, " ").trim()}`).join("\n\n");
      return ok(text, { results: hits });
    },
  );

  server.registerTool(
    "read_doc",
    {
      title: "Read a docs page",
      description: "The full text of a docs section, or a whole page when the link has no #. Pass a link from search_docs.",
      inputSchema: { url: z.string().min(1).max(2000).describe("A link from search_docs") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ url }) => {
      if (!caller.allow.call()) return fail(TOO_MANY);
      const doc = readDoc(db, url);
      return doc ? ok(doc) : fail("No page or section has that link. Use a link from search_docs.");
    },
  );

  if (desk && kinds.length) {
    const kindList = kinds.join(" or ");
    server.registerTool(
      "file_report",
      {
        title: kinds.length === 2 ? "Report a bug or request a feature" : kinds[0] === "bug" ? "Report a bug" : "Request a feature",
        description:
          `File a ${kinds.map((k) => (k === "bug" ? "bug report" : "feature request")).join(" or ")} with the ${deps.productName} team. ` +
          "First call checks the team's open tickets: if some might be the same thing, nothing is filed and you get them back. " +
          "Then call again with duplicate_of set to the matching key, or new_ticket: true if none match. " +
          `${hearsBack ? "The user hears back when it's fixed, planned or declined: use ticket_status. " : ""}Confirm with the user before filing.`,
        inputSchema: {
          kind: z.enum(kinds as [ReportKind, ...ReportKind[]]).describe(`${kindList}`),
          title: z.string().min(3).max(200).describe("Short and specific, under 80 characters, no trailing period"),
          description: z
            .string()
            .min(10)
            .max(4000)
            .describe(
              "Markdown for an engineer who wasn't there. Bugs: what happened, what they expected, '## Steps to reproduce' and '## Context' (version, platform, error text). Ideas: what they want and why. Only facts from the user; never invent steps.",
            ),
          summary: z.string().min(3).max(300).describe("The thing in the user's own words, a short phrase, e.g. \"the timer drifting after a pause\""),
          duplicate_of: z.string().max(200).optional().describe("Key of an existing ticket this is the same as, from a previous call"),
          new_ticket: z.boolean().optional().describe("True when you've checked the possible duplicates and none match"),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (input) => {
        if (!caller.allow.call()) return fail(TOO_MANY);
        if (deps.maxTextLength && input.description.length > deps.maxTextLength) return fail(`Descriptions can be up to ${deps.maxTextLength} characters here.`);
        let found: Awaited<ReturnType<typeof desk.find>> = [];
        if (input.duplicate_of || !input.new_ticket) {
          try {
            found = await desk.find(`${input.title}\n${input.summary}`);
          } catch (err) {
            console.error("mcp: duplicate search failed", err);
            return fail("Couldn't check the team's open tickets just now, so nothing was filed. Try again in a bit.");
          }
        }
        // Only a ticket this report was offered, or one this person already reported, can be joined. Any
        // other key would hand back the title of a ticket they were never shown (another visitor's, or an internal one).
        if (input.duplicate_of) {
          const want = input.duplicate_of.trim().toLowerCase();
          const own = service.forUser(identity.id).flatMap((m) => desk.forConversation(m.id).map((t) => t.key.toLowerCase()));
          if (!found.some((t) => t.key.toLowerCase() === want) && !own.includes(want)) {
            return fail(`${input.duplicate_of} isn't one of the tickets offered for this report. Use a key from the list (same title and summary), or new_ticket: true.`);
          }
        }
        if (!input.duplicate_of && !input.new_ticket) {
          if (found.length) {
            const list = found.map((t) => `- ${t.key}: ${t.title}${t.reports ? ` (${t.reports} ${t.reports === 1 ? "report" : "reports"})` : ""}`).join("\n");
            return ok(
              `Nothing filed yet. These open tickets might be the same thing:\n${list}\n\nIf one matches, call file_report again with duplicate_of set to its key, so this report joins it. Otherwise call again with new_ticket: true.`,
              { status: "possible_duplicates", candidates: found.map((t) => ({ key: t.key, title: t.title, url: absolute(t.url), reports: t.reports })) },
            );
          }
        }
        // Each report starts a conversation, so it counts against the same limit as starting a chat.
        if (!caller.allow.report()) return fail("Too many reports, try again later.");
        const client = caller.client ?? clientName(server);
        try {
          const result = await service.fileReport({
            identity,
            visitorKey: caller.visitorKey,
            client,
            kind: input.kind,
            title: input.title,
            description: input.description,
            summary: input.summary,
            duplicateOf: input.duplicate_of,
          });
          if (result.outcome === "no_such_ticket") return fail(`There's no ticket ${input.duplicate_of}. Use a key from the list, or new_ticket: true.`);
          const t = { key: result.ticket.key, title: result.ticket.title, url: absolute(result.ticket.url) };
          const status = { status: result.outcome, report_id: result.conversation.id, ticket: t, chat_url: chatUrl(result.conversation) };
          const later = hearsBack ? " Check back with ticket_status; they'll hear back when it moves." : "";
          const text = {
            filed: `Filed ${t.key}: ${t.title}.${later}`,
            added: `Added to ${t.key}: ${t.title}, which already covers this. The team sees it as another report.${later}`,
            planned: `Added to ${t.key}: ${t.title}. The team already plans to build it.${later}`,
            done: `${t.key} (${t.title}) is already done. It should be fixed in the latest version.`,
            already: `They already reported this: it's on ${t.key} (${t.title}).`,
          }[result.outcome];
          return ok(`${text}\nReport id: ${result.conversation.id}`, status);
        } catch (err) {
          console.error("mcp: file_report failed", err);
          return fail("The tracker didn't take it. Try again in a bit.");
        }
      },
    );
  }

  server.registerTool(
    "ticket_status",
    {
      title: "Check on reports",
      description: "Where this user's reports stand: open, planned, fixed or declined, with the ticket and anything the team wrote back. Pass report_id for one report, or nothing for their recent ones.",
      inputSchema: { report_id: z.string().max(64).optional().describe("From file_report") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ report_id }) => {
      if (!caller.allow.call()) return fail(TOO_MANY);
      if (!desk) return ok("No tracker is set up, so there are no reports to check.", { reports: [] });
      const one = report_id ? service.get(report_id) : null;
      if (report_id && (!one || one.userId !== identity.id)) return fail("No report with that id for this user.");
      const ids = one ? [{ id: one.id, token: one.token }] : service.forUser(identity.id);
      const reports = ids.flatMap((conv) => reportStatus(service, conv, absolute, chatUrl)).slice(0, 20);
      if (!reports.length) return ok("No reports yet.", { reports: [] });
      const text = reports
        .map((r) => {
          const lines = [`${r.ticket.key}: ${r.ticket.title} — ${r.state}`, `  reported ${new Date(r.reported_at).toISOString().slice(0, 10)}${r.ticket.url ? `, ${r.ticket.url}` : ""}`];
          if (r.news) lines.push(`  ${r.news}`);
          for (const reply of r.team_replies) lines.push(`  ${reply.from}: ${reply.body}`);
          return lines.join("\n");
        })
        .join("\n\n");
      return ok(text, { reports });
    },
  );

  return server;

  function chatUrl(conv: { id: string; token: string }): string | null {
    return deps.publicUrl ? `${deps.publicUrl.replace(/\/$/, "")}/chat/${conv.id}#${conv.token}` : null;
  }
}

/** One conversation's reports, as ticket_status shows them. */
function reportStatus(
  service: ConversationService,
  conv: { id: string; token: string },
  absolute: (url: string) => string,
  chatUrl: (conv: { id: string; token: string }) => string | null,
) {
  const tickets = service.tickets?.forConversation(conv.id) ?? [];
  if (!tickets.length) return [];
  const messages = service.list(conv.id);
  const cards = messages.filter((m) => m.card);
  const replies = messages.filter((m) => m.author === "staff").slice(-3);
  return tickets.map((t) => {
    // Each ticket's own cards, by the reporter's words for it; news about a ticket uses its title when they gave none.
    const words = new Set([t.summary?.trim(), `"${t.title}"`].filter(Boolean));
    const own = cards.filter((m) => words.has(m.card!.summary));
    const latest = (own.length ? own : tickets.length === 1 ? cards : []).at(-1);
    // The tracker says done or closed; the cards say planned or declined, and what the team said.
    const stage = latest?.card?.stage;
    const state = t.state === "done" ? "done" : t.state === "closed" ? (stage === "declined" ? "declined" : "closed") : stage === "planned" ? "planned" : "open";
    return {
      report_id: conv.id,
      ticket: { key: t.key, title: t.title, url: absolute(t.url) },
      state,
      relation: t.relation,
      reported_at: (own[0] ?? cards[0] ?? messages[0])?.createdAt ?? 0,
      news: latest && latest.card?.stage !== "logged" ? latest.body : null,
      team_replies: replies.map((m) => ({ from: m.authorName ?? "The team", body: m.body.slice(0, 1000), at: m.createdAt })),
      chat_url: chatUrl(conv),
    };
  });
}

/** The client's name from the handshake, e.g. "claude-code". */
function clientName(server: McpServer): string | null {
  const info = server.server.getClientVersion();
  return info?.name ? info.name.slice(0, 80) : null;
}

function ok(text: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) };
}

function fail(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
