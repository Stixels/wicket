import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectLive, type EventSourceLike } from "../admin/live.js";

class FakeSource implements EventSourceLike {
  readyState = 0;
  onerror: ((e: unknown) => void) | null = null;
  closed = false;
  listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(public url: string) {}
  addEventListener(type: string, listener: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data = "{}") {
    if (type === "ready") this.readyState = 1;
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
  fail(closed: boolean) {
    this.readyState = closed ? 2 : 0;
    this.onerror?.({});
  }
}

class FakeTarget {
  visibilityState = "visible";
  handlers = new Map<string, Set<() => void>>();
  addEventListener(type: string, l: () => void) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(l);
  }
  removeEventListener(type: string, l: () => void) {
    this.handlers.get(type)?.delete(l);
  }
  fire(type: string) {
    for (const l of this.handlers.get(type) ?? []) l();
  }
}

function setup() {
  const sources: FakeSource[] = [];
  const status: [boolean, boolean][] = [];
  const events: string[] = [];
  const win = new FakeTarget();
  const doc = new FakeTarget();
  const stop = connectLive({
    url: "/admin/api/events",
    types: ["message"],
    onEvent: (type) => events.push(type),
    onStatus: (up, resumed) => status.push([up, resumed]),
    create: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s;
    },
    win,
    doc,
    now: () => Date.now(),
  });
  return { sources, status, events, win, doc, stop, last: () => sources[sources.length - 1] };
}

describe("dashboard live connection", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reopens after the browser gives up on a failed reconnect", () => {
    const t = setup();
    t.last().emit("ready");
    expect(t.status).toEqual([]);
    t.last().fail(true); // e.g. a 502 during a deploy: EventSource stops retrying
    expect(t.status).toEqual([[false, false]]);
    vi.advanceTimersByTime(2000);
    expect(t.sources).toHaveLength(2);
    t.last().emit("ready");
    expect(t.status).toEqual([[false, false], [true, true]]);
  });

  it("leaves the browser's own retry alone while it is still connecting", () => {
    const t = setup();
    t.last().emit("ready");
    t.last().fail(false);
    vi.advanceTimersByTime(5000);
    expect(t.sources).toHaveLength(1);
    t.last().emit("ready");
    expect(t.status).toEqual([[false, false], [true, true]]);
  });

  it("replaces a connection that has gone quiet", () => {
    const t = setup();
    t.last().emit("ready");
    vi.advanceTimersByTime(50_000);
    t.last().emit("ping");
    vi.advanceTimersByTime(50_000);
    expect(t.sources).toHaveLength(1);
    vi.advanceTimersByTime(30_000);
    expect(t.sources).toHaveLength(2);
    expect(t.sources[0].closed).toBe(true);
    expect(t.status).toEqual([[false, false]]);
  });

  it("retries right away when the tab comes back", () => {
    const t = setup();
    t.last().emit("ready");
    t.last().fail(true);
    // Backoff grows while failing.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(40_000);
      t.last().fail(true);
    }
    const before = t.sources.length;
    t.doc.fire("visibilitychange");
    expect(t.sources).toHaveLength(before + 1);
    t.last().emit("ready");
    expect(t.status.at(-1)).toEqual([true, true]);
  });

  it("does nothing on focus when the connection is healthy", () => {
    const t = setup();
    t.last().emit("ready");
    t.win.fire("focus");
    t.win.fire("online");
    expect(t.sources).toHaveLength(1);
  });

  it("passes events through and ignores the old connection once replaced", () => {
    const t = setup();
    t.last().emit("ready");
    const old = t.last();
    old.fail(true);
    vi.advanceTimersByTime(2000);
    old.emit("message");
    t.last().emit("message");
    expect(t.events).toEqual(["message"]);
  });

  it("cleans up when stopped", () => {
    const t = setup();
    t.stop();
    expect(t.last().closed).toBe(true);
    vi.advanceTimersByTime(200_000);
    expect(t.sources).toHaveLength(1);
    expect(t.doc.handlers.get("visibilitychange")?.size).toBe(0);
  });
});
