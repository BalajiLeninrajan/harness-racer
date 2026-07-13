import { describe, expect, it } from "vitest";
import type { ProviderInfo, RunResult, ServerEvent } from "../src/shared/types.js";
import {
  configureActivation,
  competitorsFromSelection,
  defaultSelection,
  emptyRaceState,
  filterRacerOptions,
  outputTail,
  raceGridColumns,
  racerOptions,
  reduceRaceEvent,
} from "../src/tui/model.js";

function provider(overrides: Partial<ProviderInfo> & Pick<ProviderInfo, "id" | "name">): ProviderInfo {
  return {
    command: overrides.id,
    installed: true,
    authenticated: true,
    models: [{ id: `${overrides.id}-default`, label: `${overrides.name} Default` }],
    ...overrides,
  };
}

describe("terminal UI model", () => {
  it("starts from Enter anywhere on the grid and keeps Space for focused choices", () => {
    for (let cursor = 0; cursor <= 5; cursor += 1) {
      expect(configureActivation(cursor, "enter")).toEqual({ type: "start" });
    }

    expect([0, 1, 2, 3, 4, 5].map((cursor) => configureActivation(cursor, "space"))).toEqual([
      { type: "mode", value: "parallel" },
      { type: "mode", value: "sequential" },
      { type: "preset", value: "quick" },
      { type: "preset", value: "standard" },
      { type: "preset", value: "thorough" },
      { type: "start" },
    ]);
  });

  it("lists only runnable harness/model pairs and picks distinct harnesses by default", () => {
    const options = racerOptions([
      provider({
        id: "codex",
        name: "Codex",
        models: [
          { id: "gpt-5", label: "GPT-5" },
          { id: "gpt-5-mini", label: "GPT-5 Mini" },
        ],
      }),
      provider({ id: "cursor", name: "Cursor" }),
      provider({ id: "grok", name: "Grok", authenticated: false }),
    ]);

    expect(options.map((option) => option.key)).toEqual([
      "codex:gpt-5",
      "codex:gpt-5-mini",
      "cursor:cursor-default",
    ]);
    expect(defaultSelection(options)).toEqual([
      "codex:gpt-5",
      "cursor:cursor-default",
      "codex:gpt-5-mini",
    ]);
  });

  it("turns selected options into stable benchmark competitors", () => {
    const options = racerOptions([
      provider({ id: "codex", name: "Codex" }),
      provider({ id: "cursor", name: "Cursor" }),
    ]);
    const competitors = competitorsFromSelection(options, options.map((option) => option.key));

    expect(competitors).toMatchObject([
      { id: "tui-0-codex-codex-default", harness: "codex", model: "codex-default", label: "Codex Default" },
      { id: "tui-1-cursor-cursor-default", harness: "cursor", model: "cursor-default", label: "Cursor Default" },
    ]);
  });

  it("sorts defaults first and searches within the active harness", () => {
    const options = racerOptions([
      provider({
        id: "codex",
        name: "Codex",
        models: [
          { id: "gpt-5-mini", label: "GPT-5 Mini" },
          { id: "gpt-5", label: "GPT-5", isDefault: true },
        ],
      }),
      provider({ id: "cursor", name: "Cursor", models: [{ id: "gpt-5", label: "GPT-5 Cursor" }] }),
    ]);

    expect(options.map((option) => option.key)).toEqual([
      "codex:gpt-5",
      "codex:gpt-5-mini",
      "cursor:gpt-5",
    ]);
    expect(filterRacerOptions(options, "codex", "mini").map((option) => option.key)).toEqual(["codex:gpt-5-mini"]);
    expect(filterRacerOptions(options, "codex", "cursor")).toEqual([]);
  });

  it("chooses responsive pane grids and keeps multiple lines of output", () => {
    expect(raceGridColumns(78, 6)).toBe(2);
    expect(raceGridColumns(118, 6)).toBe(3);
    expect(raceGridColumns(198, 6)).toBe(3);
    expect(raceGridColumns(235, 6)).toBe(6);

    expect(outputTail("one two three four five", 7, 2)).toBe("four fi\nve");
    expect(outputTail("one\ntwo\nthree", 20, 2)).toBe("two\nthree");
  });

  it("projects benchmark events into live lane and result state", () => {
    const result: RunResult = {
      competitorId: "racer",
      workload: "prose",
      sample: 1,
      warmup: false,
      output: "hello world",
      valid: true,
      metrics: {
        harnessPrepMs: 20,
        promptToFirstOutputMs: 30,
        coldStartToFirstOutputMs: 50,
        visibleStreamMs: 100,
        promptToFinishMs: 130,
        visibleTokens: 2,
        visibleTokensPerSecond: 20,
        streamChunkCount: 2,
      },
    };
    const events: ServerEvent[] = [
      { type: "benchmark.started", benchmarkId: "bench", totalRuns: 4 },
      { type: "run.status", competitorId: "racer", workload: "prose", sample: 1, warmup: false, status: "running" },
      { type: "run.delta", competitorId: "racer", workload: "prose", sample: 1, text: "hello", elapsedMs: 30 },
      { type: "run.complete", result },
    ];

    const state = events.reduce(reduceRaceEvent, emptyRaceState());
    expect(state).toMatchObject({ totalRuns: 4, completedRuns: 1 });
    expect(state.lanes.racer).toMatchObject({
      status: "complete",
      output: "hello world",
      harnessPrepMs: 20,
      firstOutputMs: 30,
      visibleTokensPerSecond: 20,
      completedRuns: 1,
    });

    const nextRun = reduceRaceEvent(state, {
      type: "run.status",
      competitorId: "racer",
      workload: "code",
      sample: 1,
      warmup: false,
      status: "starting",
    });
    expect(nextRun.lanes.racer).toMatchObject({ status: "starting", output: "" });
    expect(nextRun.lanes.racer.harnessPrepMs).toBeUndefined();
    expect(nextRun.lanes.racer.firstOutputMs).toBeUndefined();
  });
});
