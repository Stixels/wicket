import { describe, expect, it } from "vitest";
import { Trail, clickLabel, pageLabel, type ElementLike } from "../widget/trail.js";

/** A stand-in for a DOM element: tag, attributes, text and parent. */
function el(tagName: string, attrs: Record<string, string> = {}, text = "", parent: ElementLike | null = null): ElementLike {
  return { tagName, getAttribute: (n) => attrs[n] ?? null, textContent: text, parentElement: parent };
}

describe("widget trail", () => {
  it("names a click by the button or link's label, never by what's typed", () => {
    expect(clickLabel(el("BUTTON", {}, "  Pause   game "))).toBe("Pause game");
    expect(clickLabel(el("A", { "aria-label": "Room Dashboard" }, "🏠"))).toBe("Room Dashboard");
    // A click on an icon inside a button counts as the button.
    expect(clickLabel(el("svg", {}, "", el("SPAN", {}, "Send", el("BUTTON", {}, "Send Clue"))))).toBe("Send Clue");
    expect(clickLabel(el("DIV", { role: "button" }, "Resume"))).toBe("Resume");
    expect(clickLabel(el("INPUT", { type: "submit", value: "Save puzzle" }))).toBe("Save puzzle");
    // Text fields, their contents and plain text aren't recorded at all.
    expect(clickLabel(el("INPUT", { type: "text", value: "my secret note" }))).toBeNull();
    expect(clickLabel(el("INPUT", { value: "typed" }))).toBeNull();
    expect(clickLabel(el("TEXTAREA", {}, "typed text"))).toBeNull();
    expect(clickLabel(el("DIV", { contenteditable: "true" }, "typed", el("BUTTON", {}, "Wrapper")))).toBeNull();
    expect(clickLabel(el("SELECT", {}, "Option A"))).toBeNull();
    expect(clickLabel(el("P", {}, "Just some text"))).toBeNull();
    expect(clickLabel(el("BUTTON", {}, "x".repeat(200)))).toBe(`${"x".repeat(79)}…`);
  });

  it("keeps a page's path and route, not its query string", () => {
    expect(pageLabel({ pathname: "/rooms/12", hash: "" })).toBe("/rooms/12");
    expect(pageLabel({ pathname: "/app", hash: "#/rooms/12/dashboard" })).toBe("/app#/rooms/12/dashboard");
    expect(pageLabel({ pathname: "/app", hash: "#access_token=abc" })).toBe("/app");
    expect(pageLabel({ pathname: "/app", hash: "#/callback?code=abc" })).toBe("/app#/callback");
  });

  it("keeps the last 20 steps from the last 5 minutes, timed before the report", () => {
    let now = 1_000_000;
    const trail = new Trail(() => now);
    trail.add("page", "/old");
    now += 6 * 60 * 1000;
    for (let i = 0; i < 25; i++) {
      trail.add("click", `Button ${i}`);
      now += 1000;
    }
    const steps = trail.snapshot();
    expect(steps).toHaveLength(20);
    expect(steps[0]).toEqual({ ago: 20, type: "click", label: "Button 5" });
    expect(steps.at(-1)).toEqual({ ago: 1, type: "click", label: "Button 24" });
    // A snapshot up to an earlier moment leaves out what came after it.
    expect(trail.snapshot(now - 3000).at(-1)).toEqual({ ago: 0, type: "click", label: "Button 22" });
  });

  it("records nothing once turned off", () => {
    const trail = new Trail();
    trail.add("note", "Paused game");
    trail.disable();
    trail.add("note", "Sent Clue");
    expect(trail.snapshot()).toEqual([]);
  });
});
