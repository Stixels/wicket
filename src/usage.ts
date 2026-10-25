import { and, eq, gte, sql } from "drizzle-orm";
import { schema, type Db } from "./db/index.js";
import type { Price } from "./settings.js";

/** Token counts from one model response, as the Messages API reports them. */
export interface TokenUsage {
  model: string;
  input: number; // uncached input
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** What the AI Gateway billed for this response, when it says. It beats a price-table estimate. */
  billedMicros?: number;
}

/**
 * List prices in US dollars per million tokens. Settings can override or add to these.
 * Keys are matched after dropping a "provider/" prefix and turning dots into dashes,
 * so "anthropic/claude-haiku-5.5" and "claude-haiku-5-5" share a row.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** Used for a model with no known price, so a budget is never silently weaker than it says. */
export const UNKNOWN_MODEL_PRICE: Price = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 };

const normalize = (model: string) => model.replace(/^[^/]+\//, "").replace(/\./g, "-").toLowerCase();

export function priceFor(model: string, overrides: Record<string, Price> = {}): Price | null {
  const all = { ...DEFAULT_PRICES, ...overrides };
  return all[model] ?? Object.entries(all).find(([k]) => normalize(k) === normalize(model))?.[1] ?? null;
}

/** Cost in millionths of a dollar, rounded up. */
export function costMicros(u: TokenUsage, overrides: Record<string, Price> = {}): number {
  if (u.billedMicros !== undefined) return u.billedMicros;
  const p = priceFor(u.model, overrides) ?? UNKNOWN_MODEL_PRICE;
  const dollarsPerMillion =
    u.input * p.input + u.output * p.output + u.cacheRead * (p.cacheRead ?? p.input) + u.cacheWrite * (p.cacheWrite ?? p.input);
  return Math.ceil(dollarsPerMillion); // (tokens × $/1M) = micro-dollars
}

export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The spend ledger. Rows outlive their conversation so a deleted chat doesn't refund a budget. */
export class UsageLedger {
  constructor(
    private db: Db,
    private prices: Record<string, Price> = {},
  ) {}

  record(conversationId: string, payer: string, profile: string, usage: TokenUsage[], now = new Date()): number {
    let total = 0;
    for (const u of usage) {
      const cost = costMicros(u, this.prices);
      total += cost;
      this.db
        .insert(schema.usage)
        .values({
          conversationId,
          payer,
          profile,
          model: u.model,
          inputTokens: u.input,
          outputTokens: u.output,
          cacheReadTokens: u.cacheRead,
          cacheWriteTokens: u.cacheWrite,
          costMicros: cost,
          createdAt: now,
        })
        .run();
    }
    return total;
  }

  /** Micro-dollars spent this calendar month by one payer, or by everyone when payer is null. */
  spentThisMonth(payer: string | null, now = new Date()): number {
    const since = monthStart(now);
    const where = payer ? and(eq(schema.usage.payer, payer), gte(schema.usage.createdAt, since)) : gte(schema.usage.createdAt, since);
    const row = this.db
      .select({ total: sql<number>`coalesce(sum(${schema.usage.costMicros}), 0)` })
      .from(schema.usage)
      .where(where)
      .get();
    return Number(row?.total ?? 0);
  }
}

export const dollarsToMicros = (d: number) => Math.round(d * 1_000_000);
