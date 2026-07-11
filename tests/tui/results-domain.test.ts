import { describe, expect, it } from "vitest";

import type { Competitor, RunResult, SummaryRow } from "../../src/shared/types.js";
import {
  classificationEntries,
  crown,
  expectedMeasured,
  place,
  placeColor,
  range,
  workloadDetail,
} from "../../src/tui/domain/results.js";

const competitors: Competitor[] = [
  { id: "first", harness: "codex", model: "fast", label: "Codex", color: "cyan" },
  { id: "second", harness: "cursor", model: "fast", label: "Cursor", color: "magenta" },
  { id: "missing", harness: "grok", model: "fast", label: "Grok", color: "blue" },
];

function summary(
  competitor: Competitor,
  finishRank: number,
  overrides: Partial<SummaryRow> = {},
): SummaryRow {
  return {
    competitor,
    measuredRuns: 2,
    validRuns: 2,
    anomalousRuns: 0,
    disqualified: false,
    promptToFirstOutputMs: 100,
    coldStartToFirstOutputMs: 110,
    promptToFinishMs: 600,
    visibleTokensPerSecond: 100,
    finishRank,
    crowns: [],
    ...overrides,
  };
}

function result(
  workload: RunResult["workload"],
  finishMs: number,
  overrides: Partial<RunResult> = {},
): RunResult {
  return {
    competitorId: "first",
    workload,
    sample: 1,
    warmup: false,
    output: "output",
    valid: true,
    metrics: {
      harnessPrepMs: 10,
      promptToFirstOutputMs: finishMs / 2,
      coldStartToFirstOutputMs: finishMs / 2 + 10,
      visibleStreamMs: finishMs / 2,
      promptToFinishMs: finishMs,
      visibleTokens: 50,
      visibleTokensPerSecond: 100,
      streamChunkCount: 3,
    },
    ...overrides,
  };
}

describe("TUI results domain", () => {
  it("keeps summary order and appends competitors without a result", () => {
    const rows = [summary(competitors[1], 1), summary(competitors[0], 2)];
    const entries = classificationEntries(competitors, { summary: rows });

    expect(entries.map(({ competitor }) => competitor.id)).toEqual(["second", "first", "missing"]);
    expect(entries.map(place)).toEqual(["P1", "P2", "DNF"]);
    expect(entries.map(placeColor)).toEqual(["#ffd700", "#bcbcbc", "#ff5f5f"]);
  });

  it("aggregates valid workload samples and formats their finish range", () => {
    const detail = workloadDetail([
      result("prose", 400),
      result("prose", 600),
      result("prose", 9_000, { valid: false }),
      result("code", 200),
      result("prose", 100, { warmup: true }),
    ], "prose", false);

    expect(detail).toMatchObject({
      valid: 2,
      recorded: 3,
      totalMs: 500,
      minMs: 400,
      maxMs: 600,
      firstMs: 250,
      rate: 100,
      chunks: 3,
    });
    expect(range(detail)).toBe("500ms (400ms–600ms)");
  });

  it("uses anomalous samples only when a disqualified racer has no valid result", () => {
    const invalid = result("prose", 800, { valid: false });

    expect(workloadDetail([invalid], "prose", false).totalMs).toBe(Number.POSITIVE_INFINITY);
    expect(workloadDetail([invalid], "prose", true).totalMs).toBe(800);
    expect(range(workloadDetail([], "prose", true))).toBe("—");
  });

  it("derives run counts, disqualification labels, and metric crowns", () => {
    const disqualified = {
      competitor: competitors[0],
      summary: summary(competitors[0], 3, { disqualified: true, crowns: ["visibleSpeed"] }),
    };

    expect(expectedMeasured({ samplePreset: "quick" })).toBe(2);
    expect(expectedMeasured({ samplePreset: "standard" })).toBe(6);
    expect(expectedMeasured({ samplePreset: "thorough" })).toBe(10);
    expect(place(disqualified)).toBe("DSQ");
    expect(placeColor(disqualified)).toBe("#ff5f5f");
    expect(crown(disqualified.summary, "visibleSpeed")).toBe("★");
    expect(crown(disqualified.summary, "finish")).toBe("");
  });
});
