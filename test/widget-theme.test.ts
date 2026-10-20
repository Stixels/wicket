import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { ConversationService } from "../src/conversations.js";
import { createServer } from "../src/server.js";
import { parseSettings } from "../src/settings.js";
import { FakeRelay } from "./helpers.js";

describe("widget.js", () => {
  it("carries the configured theme so the widget opens in the host's colors", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wicket-widget-"));
    const widgetPath = path.join(dir, "widget.js");
    fs.writeFileSync(widgetPath, 'theme("__WICKET_SERVER_THEME__");');
    const settings = parseSettings('theme:\n  accentColor: "#DD3333"\n  cssVars:\n    --wk-bg: "#181414"\n');
    const service = new ConversationService(openDb(":memory:"), null, new FakeRelay(), { settings });
    const app = createServer(service, { allowedOrigins: [], maxConversationsPerIpPerHour: 50, maxMessagesPerConversationPerHour: 50, widgetPath });

    const body = await (await app.request("/widget.js")).text();
    // The placeholder becomes a JS string literal holding the theme as JSON.
    const literal = /^theme\((".*")\);$/.exec(body)![1];
    expect(JSON.parse(JSON.parse(literal) as string)).toMatchObject({ accentColor: "#DD3333", cssVars: { "--wk-bg": "#181414" } });
  });
});
