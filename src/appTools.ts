import { z } from "zod";
import type { AppTools } from "./agent/agent.js";
import type { Evidence } from "./db/schema.js";

/**
 * Tools the host app offers, called as the signed-in person: the host's own backend checks the
 * person's signed token on every call, so Wicket never sees data the person couldn't see in the app.
 *
 *   GET  {url}?context=<json>   -> { instructions, tools: [{ name, description, inputSchema }] }
 *   POST {url}/{name}           -> { content, evidence? }   body { input, context, evidenceStart }
 */

const definitions = z.object({
  instructions: z.string().max(40_000).default(""),
  tools: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        description: z.string().max(4000),
        inputSchema: z.record(z.string(), z.unknown()),
      }),
    )
    .max(32),
});

const evidenceSchema = z.object({
  id: z.string().max(16),
  label: z.string().max(200),
  value: z.string().max(200),
  period: z.string().max(120).optional(),
  basis: z.string().max(120).optional(),
  caveats: z.array(z.string().max(300)).max(5).optional(),
});

const callResult = z.object({
  content: z.unknown(),
  evidence: z.array(z.unknown()).max(50).optional(),
});

const TIMEOUT_MS = 20_000;

export interface AppToolsTurn {
  tools: AppTools;
  /** Evidence the tools returned during this answer, in order. */
  evidence: Evidence[];
}

/** Loads the host's tools for one answer. Returns null when the host can't be reached, so the answer goes ahead without them. */
export async function loadAppTools(
  url: string,
  userToken: string,
  context: Record<string, unknown> | null,
  fetchImpl: typeof fetch = fetch,
): Promise<AppToolsTurn> {
  const base = url.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" };
  const listUrl = `${base}?context=${encodeURIComponent(JSON.stringify(context ?? {}))}`;
  const res = await fetchImpl(listUrl, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`app tools list returned ${res.status}`);
  const defs = definitions.parse(await res.json());
  const evidence: Evidence[] = [];

  const call: AppTools["call"] = async (name, input) => {
    const r = await fetchImpl(`${base}/${encodeURIComponent(name)}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input, context: context ?? {}, evidenceStart: evidence.length }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      const error = typeof data.error === "string" ? data.error : `The app returned ${r.status}.`;
      return { content: error.slice(0, 1000), isError: true };
    }
    const parsed = callResult.safeParse(data);
    if (!parsed.success) return { content: "The app sent a result Wicket couldn't read.", isError: true };
    for (const item of parsed.data.evidence ?? []) {
      const e = evidenceSchema.safeParse(item);
      if (e.success) evidence.push(e.data);
    }
    const content = typeof parsed.data.content === "string" ? parsed.data.content : JSON.stringify(parsed.data.content);
    return { content: content.slice(0, 60_000) };
  };

  return { tools: { instructions: defs.instructions, tools: defs.tools, call }, evidence };
}

/** Only the evidence the answer cites, when it cites any by id ([E1]); otherwise all of it. */
export function citedEvidence(reply: string, evidence: Evidence[]): Evidence[] {
  // Markers can be grouped or ranged, as in [E1, E4] or [E1–E3].
  const cited = new Set(
    [...reply.matchAll(/\[E\d+(?:\s*[,\u2013-]\s*E\d+)*\]/g)].flatMap((m) =>
      m[0]
        .slice(1, -1)
        .split(",")
        .flatMap((part) => {
          const [from, to = from] = (part.match(/\d+/g) ?? []).map(Number);
          if (from === undefined) return [];
          return Array.from({ length: Math.min(Math.max(to - from + 1, 1), 50) }, (_, i) => `E${from + i}`);
        }),
    ),
  );
  if (!cited.size) return evidence;
  const some = evidence.filter((e) => cited.has(e.id));
  return some.length ? some : evidence;
}
