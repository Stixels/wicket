// The dashboard's live-update connection.
//
// A plain EventSource gives up for good when a reconnect gets an HTTP error (a 502 while Railway
// swaps containers, say), and after a laptop sleeps it can sit on a dead socket that never errors.
// This keeps one connection alive: it reopens with backoff when the browser stops retrying,
// replaces a connection that has gone quiet (the server pings every 25 s), and tries again right
// away when the tab comes back into view or the network returns.

export interface EventSourceLike {
  readyState: number;
  onerror: ((e: unknown) => void) | null;
  addEventListener(type: string, listener: (e: { data: string }) => void): void;
  close(): void;
}

interface Target {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface LiveOptions {
  url: string;
  /** Event types to pass to onEvent ("ready" and "ping" are handled here). */
  types: string[];
  onEvent: (type: string, data: string) => void;
  /** connected flips with the connection; resumed is true when it came back after a drop. */
  onStatus: (connected: boolean, resumed: boolean) => void;
  create?: (url: string) => EventSourceLike;
  /** Where to listen for focus/online changes. */
  win?: Target;
  doc?: Target & { visibilityState: string };
  now?: () => number;
  /** A connection with nothing (not even a ping) for this long is treated as dead. */
  staleMs?: number;
}

const CLOSED = 2;

export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return Math.round(base * (0.75 + random() * 0.5));
}

export function connectLive(opts: LiveOptions): () => void {
  const create = opts.create ?? ((url) => new EventSource(url) as unknown as EventSourceLike);
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? 60_000;
  const win = opts.win ?? window;
  const doc = opts.doc ?? document;

  let es: EventSourceLike | null = null;
  let connected = true;
  let everConnected = false;
  let attempt = 0;
  let lastSeen = now();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const setConnected = (value: boolean, resumed = false) => {
    if (value === connected && !resumed) return;
    connected = value;
    opts.onStatus(value, resumed);
  };

  const open = () => {
    clearTimeout(retry);
    retry = undefined;
    es?.close();
    lastSeen = now();
    const source = create(opts.url);
    es = source;
    const seen = () => {
      if (es === source) lastSeen = now();
    };
    source.addEventListener("ping", seen);
    source.addEventListener("ready", () => {
      if (es !== source) return;
      seen();
      attempt = 0;
      setConnected(true, everConnected);
      everConnected = true;
    });
    for (const type of opts.types) {
      source.addEventListener(type, (e) => {
        if (es !== source) return;
        seen();
        opts.onEvent(type, e.data);
      });
    }
    source.onerror = () => {
      if (es !== source) return;
      setConnected(false);
      // While CONNECTING the browser is retrying on its own. CLOSED means it gave up.
      if (source.readyState === CLOSED) schedule();
    };
  };

  const schedule = () => {
    if (stopped || retry !== undefined) return;
    retry = setTimeout(open, backoffMs(attempt++));
  };

  const stale = () => now() - lastSeen > staleMs;

  // A connection that went quiet (sleep, a dropped proxy) never errors, so check for silence.
  const watchdog = setInterval(() => {
    if (stopped || retry !== undefined) return;
    if (stale()) {
      setConnected(false);
      open();
    }
  }, 10_000);

  const wake = () => {
    if (stopped || doc.visibilityState === "hidden") return;
    if (!connected || stale() || es?.readyState === CLOSED) {
      attempt = 0;
      open();
    }
  };

  doc.addEventListener("visibilitychange", wake);
  win.addEventListener("online", wake);
  win.addEventListener("focus", wake);

  open();

  return () => {
    stopped = true;
    clearTimeout(retry);
    clearInterval(watchdog);
    doc.removeEventListener("visibilitychange", wake);
    win.removeEventListener("online", wake);
    win.removeEventListener("focus", wake);
    es?.close();
    es = null;
  };
}
