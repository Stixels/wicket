import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.js";
import { ConversationService } from "../src/conversations.js";
import { createServer, type ServerOptions } from "../src/server.js";
import { FakeRelay } from "./helpers.js";

function app(opts: Partial<ServerOptions>) {
  const service = new ConversationService(openDb(":memory:"), null, new FakeRelay(), () => {});
  return createServer(service, { allowedOrigins: [], maxConversationsPerIpPerHour: 50, maxMessagesPerConversationPerHour: 50, ...opts });
}

describe("home page", () => {
  it("serves the playground at / by default", async () => {
    const res = await app({ playground: { title: "Acme Support" } }).request("/");
    expect(await res.text()).toContain("Wicket playground");
  });

  it("serves the marketing site at / and moves the playground to /playground", async () => {
    const a = app({ site: true, playground: { title: "Acme Support" } });
    const home = await (await a.request("/")).text();
    expect(home).toContain("The support chat that");
    // The site shows a scripted demo; it must not load the live widget, which would reach the real support inbox.
    expect(home).not.toMatch(/<script[^>]+src="\/widget\.js"/);
    const pg = await (await a.request("/playground?as=visitor")).text();
    expect(pg).toContain("Wicket playground");
    expect(pg).toContain('href="/playground?plan=pro"');
  });

  it("serves only the site when the playground is off", async () => {
    const a = app({ site: true });
    expect((await a.request("/")).status).toBe(200);
    expect((await a.request("/playground")).status).toBe(404);
  });
});
