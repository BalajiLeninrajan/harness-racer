import { describe, expect, it } from "vitest";
import {
  MIN_MEASURABLE_STREAM_MS,
  countNormalizedTokens,
  median,
  streamAnomalyMessage,
  summarizeResults,
} from "../src/server/metrics.js";
import type { Competitor, RunResult } from "../src/shared/types.js";

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
      harnessPrepMs: 100,
      promptToFirstOutputMs: totalMs / 4,
      coldStartToFirstOutputMs: 100 + totalMs / 4,
      visibleStreamMs: totalMs / 2,
      promptToFinishMs: totalMs,
      visibleTokens: 100,
      visibleTokensPerSecond: tps,
      streamChunkCount: 4,
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

  it("detects buffered chunks and callback bursts", () => {
    expect(streamAnomalyMessage(1, 1_000)).toMatch(/one buffered chunk/);
    expect(streamAnomalyMessage(4, MIN_MEASURABLE_STREAM_MS - 0.01)).toMatch(/burst across 4 chunks/);
    expect(streamAnomalyMessage(2, MIN_MEASURABLE_STREAM_MS)).toBeUndefined();
  });

  it("excludes warmups and crowns the fastest results", () => {
    const summary = summarizeResults(competitors, [
      result("a", 1_000, 80, true),
      result("a", 500, 60),
      result("b", 750, 90),
    ]);
    expect(summary[0].competitor.id).toBe("a");
    expect(summary[0].promptToFinishMs).toBe(500);
    expect(summary[0].crowns).toContain("finish");
    expect(summary[1].crowns).toContain("visibleSpeed");
  });

  it("excludes anomalous runs from medians and crowns", () => {
    const anomalous = result("a", 500, 55_114);
    anomalous.valid = false;
    anomalous.validationMessage = "Buffered burst";

    const summary = summarizeResults(competitors, [
      anomalous,
      result("a", 700, 70),
      result("b", 750, 90),
    ]);

    expect(summary[0].competitor.id).toBe("a");
    expect(summary[0].measuredRuns).toBe(2);
    expect(summary[0].validRuns).toBe(1);
    expect(summary[0].anomalousRuns).toBe(1);
    expect(summary[0].disqualified).toBe(false);
    expect(summary[0].visibleTokensPerSecond).toBe(70);
    expect(summary[0].crowns).not.toContain("visibleSpeed");
    expect(summary[1].crowns).toContain("visibleSpeed");
  });

  it("keeps fully anomalous racers in the results as disqualified", () => {
    const anomalous = result("a", 500, 55_114);
    anomalous.valid = false;
    anomalous.validationMessage = "Buffered burst";

    const summary = summarizeResults(competitors, [
      anomalous,
      result("b", 750, 90),
    ]);

    expect(summary.map((row) => row.competitor.id)).toEqual(["b", "a"]);
    expect(summary[0].finishRank).toBe(1);
    expect(summary[1]).toMatchObject({
      measuredRuns: 1,
      validRuns: 0,
      anomalousRuns: 1,
      disqualified: true,
      finishRank: 0,
      promptToFinishMs: 500,
      visibleTokensPerSecond: 55_114,
      crowns: [],
    });
  });
});
