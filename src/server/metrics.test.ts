import { describe, expect, it } from "vitest";
import type { Competitor, RunResult } from "../shared/types.js";
import { countNormalizedTokens, median, summarizeResults } from "./metrics.js";

const competitors: Competitor[] = [
  { id: "a", harness: "codex", model: "alpha", label: "Alpha", color: "#fff" },
  { id: "b", harness: "cursor", model: "beta", label: "Beta", color: "#000" },
];

function result(competitorId: string, totalMs: number, tps: number, warmup = false): RunResult {
  return {
    competitorId,
    workload: "prose",
    sample: 1,
    warmup,
    output: "ok",
    valid: true,
    metrics: {
      setupMs: 100,
      modelTtftMs: totalMs / 4,
      coldTtftMs: 100 + totalMs / 4,
      streamMs: totalMs / 2,
      totalMs,
      normalizedTokens: 100,
      normalizedTps: tps,
      deltaCount: 4,
    },
  };
}

describe("metrics", () => {
  it("counts normalized visible tokens", () => {
    expect(countNormalizedTokens("The quick brown fox writes TypeScript.")).toBeGreaterThan(5);
  });

  it("computes odd and even medians", () => {
    expect(median([9, 1, 5])).toBe(5);
    expect(median([1, 3, 7, 9])).toBe(5);
  });

  it("excludes warmups and crowns the fastest results", () => {
    const summary = summarizeResults(competitors, [
      result("a", 1_000, 80, true),
      result("a", 500, 60),
      result("b", 750, 90),
    ]);
    expect(summary[0].competitor.id).toBe("a");
    expect(summary[0].totalMs).toBe(500);
    expect(summary[0].crowns).toContain("overall");
    expect(summary[1].crowns).toContain("tps");
  });
});
