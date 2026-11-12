// Wicket's MCP server over stdio, for MCP clients on the machine where Wicket's config and
// database live. It uses the same settings, database and tracker as the server, so reports
// show up in the dashboard and reporters hear back through the server's ticket checks.
//
//   node --env-file-if-exists=.env dist/src/mcp/stdio.js     (after npm run build)
//   npm run -s mcp                                             (from source)
//
// It acts as whoever WICKET_USER_TOKEN names (a user token signed with IDENTITY_SECRET), or as the
// local user running it. It never starts the Discord bot, so the team's Discord doesn't get a
// thread for reports filed here; the dashboard and the tracker do.
import os from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config.js";
import { openDb } from "../db/index.js";
import { ConversationService } from "../conversations.js";
import { verifyUserToken, type Identity } from "../identity.js";
import { loadSettings } from "../settings.js";
import { TicketDesk } from "../tickets.js";
import { createTracker, demoSettings } from "../trackers.js";
import { demoSettingsProblems } from "../demo/index.js";
import { reindex } from "../knowledge/index.js";
import { knowledgeSources } from "../knowledge/sources.js";
import { RateLimiter } from "../server.js";
import { createMcpServer } from "./server.js";

// stdout carries the protocol; every log goes to stderr.
console.log = console.error;
console.info = console.error;

const config = loadConfig();
const settings = loadSettings(config.WICKET_CONFIG);
const db = openDb(config.DATABASE_PATH);
const demo = demoSettings(config, settings);
if (demo) {
  const problems = demoSettingsProblems(settings, config.AGENT_MODEL);
  if (problems.length) throw new Error(`DEMO=true refuses to start:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
}

const tracker = createTracker(config, db, demo);
// The server's ticket checks tell reporters when things move; this process only files.
const desk = tracker ? new TicketDesk(db, tracker, { notify: (n) => service.ticketNews(n), log: (msg, err) => console.error(msg, err ?? "") }) : null;
const service = new ConversationService(db, null, null, { settings, tickets: desk, publicUrl: config.PUBLIC_URL, demo: Boolean(demo), log: (msg, err) => console.error(msg, err ?? "") });

const identity = whoIsCalling();

// A fresh install has no docs index until the server has run once.
const indexed = (db.$client.prepare("SELECT count(*) AS n FROM docs").get() as { n: number }).n;
const sources = knowledgeSources(config, settings);
if (!indexed && sources.length) {
  void reindex(db, sources).then(
    (n) => console.error(`wicket mcp: indexed ${n} docs sections`),
    (err) => console.error("wicket mcp: couldn't index the docs", err),
  );
}

const limiter = new RateLimiter();
const server = createMcpServer(
  { service, db, productName: config.PRODUCT_NAME, publicUrl: config.PUBLIC_URL },
  {
    identity,
    visitorKey: `local:${identity.id}`,
    allow: {
      call: () => limiter.allow(`mcp:${identity.id}`, config.MAX_MESSAGES_PER_CONVERSATION_PER_HOUR),
      report: () => limiter.allow(`ip:${identity.id}`, config.MAX_CONVERSATIONS_PER_IP_PER_HOUR),
    },
  },
);
await server.connect(new StdioServerTransport());
console.error(`wicket mcp: ready on stdio as ${identity.name ?? identity.id}${tracker ? `, filing to ${tracker.name}` : ", no tracker set up"}`);

function whoIsCalling(): Identity {
  const token = process.env.WICKET_USER_TOKEN;
  if (token) {
    const verified = verifyUserToken(token, config.IDENTITY_SECRET);
    if (!verified) throw new Error("WICKET_USER_TOKEN isn't a valid, unexpired token signed with IDENTITY_SECRET");
    return verified;
  }
  const name = os.userInfo().username;
  return { id: `local:${name}`, name, email: null, plan: null, account: null, budget: null, env: null };
}
