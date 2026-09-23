import { describe, expect, it } from "vitest";
import { finishAxis, summarySentences } from "../src/client/results.js";
import type { Competitor, SummaryRow } from "../src/shared/types.js";

const row = (competitor: Partial<Competitor>, finishMs: number, rank: number, crowns: SummaryRow["crowns"] = []): SummaryRow => ({
  competitor: { id: `${rank}`, harness: "codex", model: "gpt-5", label: "GPT-5", color: "#cba6f7", ...competitor },
  measuredRuns: 6,
  validRuns: 6,
  anomalousRuns: 0,
  disqualified: false,
  promptToFirstOutputMs: 900,
  coldStartToFirstOutputMs: 2100,
  promptToFinishMs: finishMs,
  visibleTokensPerSecond: 90,
  finishRank: rank,
  crowns,
});

describe("finish axis", () => {
  it("ends on a round step at or past the slowest median", () => {
    expect(finishAxis(8100)).toEqual({ scaleMs: 10_000, ticksMs: [0, 2000, 4000, 6000, 8000, 10_000] });
    expect(finishAxis(4000)).toEqual({ scaleMs: 4000, ticksMs: [0, 1000, 2000, 3000, 4000] });
    expect(finishAxis(900).scaleMs).toBe(1000);
  });

  it("keeps at most five intervals", () => {
    for (const ms of [120, 2600, 9999, 47_000, 250_000]) expect(finishAxis(ms).ticksMs.length).toBeLessThanOrEqual(6);
  });
});

describe("summary sentences", () => {
  it("credits other bests and names what the harness alone cost", () => {
    const ranked = [
      row({}, 4200, 1, ["finish", "firstOutput", "visibleSpeed"]),
      row({ harness: "claudeAgent", model: "opus", label: "Opus" }, 5500, 2, ["coldStart"]),
      row({ harness: "cursor" }, 8100, 3),
    ];
    expect(summarySentences(ranked)).toEqual([
      "The winner also had the fastest first output at 900ms and the fastest stream at 90.0 tok/s.",
      "Opus in Claude had the quickest cold start at 2.10s.",
      "Run through Cursor instead of Codex, GPT-5 finished 3.90s later.",
    ]);
  });

  it("names every holder of a shared best", () => {
    const ranked = [
      row({}, 4200, 1, ["finish", "coldStart"]),
      { ...row({ harness: "claudeAgent", model: "opus", label: "Opus" }, 5500, 2, ["coldStart", "visibleSpeed"]), coldStartToFirstOutputMs: 2090 },
      row({ harness: "cursor", model: "gemini", label: "Gemini" }, 8100, 3, ["visibleSpeed"]),
    ];
    expect(summarySentences(ranked)).toEqual([
      "The winner and Opus in Claude shared the quickest cold start at 2.09s.",
      "Opus in Claude and Gemini in Cursor shared the fastest stream at 90.0 tok/s.",
    ]);
  });

  it("says nothing without a ranked stack", () => {
    expect(summarySentences([])).toEqual([]);
  });
});
