import { describe, expect, it } from "vitest";
import { tokenUsage } from "../src/agent/agent.js";
import { citedEvidence } from "../src/appTools.js";
import { costMicros } from "../src/usage.js";
import { hideEvidenceMarkers } from "../widget/evidence.js";

const ev = (id: string) => ({ id, label: id, value: "1" });

describe("evidence markers", () => {
  it("hides single and grouped markers from the reader", () => {
    expect(hideEvidenceMarkers("Jordan Lee gives extra time most [E1, E4]. Next is Riley [E2][E3], then [E5–E6].")).toBe(
      "Jordan Lee gives extra time most. Next is Riley, then.",
    );
    expect(hideEvidenceMarkers("See [E1](https://example.com).")).toBe("See [E1](https://example.com).");
  });

  it("counts every id in a grouped marker as cited", () => {
    const cited = citedEvidence("Most extra time [E1, E3].", [ev("E1"), ev("E2"), ev("E3")]);
    expect(cited.map((e) => e.id)).toEqual(["E1", "E3"]);
    const ranged = citedEvidence("Across the week [E1–E3].", [ev("E1"), ev("E2"), ev("E3"), ev("E4")]);
    expect(ranged.map((e) => e.id)).toEqual(["E1", "E2", "E3"]);
  });
});

describe("spend", () => {
  const usage = { inputTokens: 1000, outputTokens: 100, inputTokenDetails: {}, outputTokenDetails: {} } as Parameters<typeof tokenUsage>[1];

  it("records what the Gateway billed when it says", () => {
    expect(costMicros(tokenUsage("openai/gpt-6-luna", usage, { gateway: { cost: "0.00042" } }))).toBe(420);
  });

  it("falls back to the price table without a billed cost", () => {
    expect(costMicros(tokenUsage("openai/gpt-6-luna", usage, { gateway: {} }))).toBe(150);
  });
});
