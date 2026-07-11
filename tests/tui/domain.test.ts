import { describe, expect, it } from "vitest";

import type {
  Competitor,
  HarnessId,
  ProviderInfo,
  RunResult,
  SummaryRow,
} from "../../src/shared/types.js";
import type { HarnessAdapter } from "../../src/server/adapters/types.js";
import type { ProbedAdapter, RunnableAdapter } from "../../src/terminal.js";
import {
  categorizeProbes,
  createBenchmarkRequest,
  createCompetitors,
  createStackOptions,
  defaultStackSelection,
} from "../../src/tui/domain/competitors.js";
import {
  createRaceState,
  reduceRaceEvent,
} from "../../src/tui/domain/race-state.js";

function provider(
  id: HarnessId,
  name: string,
  overrides: Partial<ProviderInfo> = {},
): ProviderInfo {
  return {
    id,
    name,
    command: name.toLowerCase(),
    installed: true,
    authenticated: true,
    models: [{ id: "fast", label: "Fast", isDefault: true }],
    ...overrides,
  };
}

function adapter(info: Pick<ProviderInfo, "id" | "name" | "command">): HarnessAdapter {
  return {
    ...info,
    async probe() {
      throw new Error("not used");
    },
    async run() {
      return {};
    },
  };
}

function runnable(info: ProviderInfo): RunnableAdapter {
  return { adapter: adapter(info), provider: info };
}

function result(competitorId: string, overrides: Partial<RunResult> = {}): RunResult {
  return {
    competitorId,
    workload: "prose",
    sample: 1,
    warmup: false,
    output: "complete output",
    valid: true,
    metrics: {
      harnessPrepMs: 10,
      promptToFirstOutputMs: 100,
      coldStartToFirstOutputMs: 110,
      visibleStreamMs: 500,
      promptToFinishMs: 600,
      visibleTokens: 50,
      visibleTokensPerSecond: 100,
      streamChunkCount: 3,
    },
    ...overrides,
  };
}

describe("TUI competitor domain", () => {
  it("categorizes probes without treating mismatched or unavailable providers as runnable", () => {
    const codex = provider("codex", "Codex");
    const missing = provider("opencode", "OpenCode", {
      installed: false,
      authenticated: null,
      models: [],
    });
    const mismatched = provider("cursor", "Cursor");
    const probes: ProbedAdapter[] = [
      { adapter: adapter(codex), provider: codex },
      { adapter: adapter(missing), provider: missing },
      { adapter: adapter(provider("claudeAgent", "Claude")), provider: mismatched },
      { adapter: adapter(provider("grok", "Grok")), error: new Error("probe failed") },
    ];

    const catalog = categorizeProbes(probes);

    expect(catalog.runnable.map(({ provider: info }) => info.id)).toEqual(["codex"]);
    expect(catalog.unavailable).toEqual(probes.slice(1));
  });

  it("creates provider/model options and picks each provider's preferred model", () => {
    const codex = provider("codex", "Codex", {
      defaultModel: "reasoning",
      models: [
        { id: "fast", label: "Fast", isDefault: true },
        { id: "reasoning", label: "Reasoning" },
      ],
    });
    const cursor = provider("cursor", "Cursor", {
      models: [{ id: "composer", label: "Composer", isDefault: true }],
    });
    const grok = provider("grok", "Grok", {
      models: [{ id: "grok-code", label: "Grok Code" }],
    });
    const openCode = provider("opencode", "OpenCode");
    const providers = [codex, cursor, grok, openCode].map(runnable);
    const options = createStackOptions(providers);

    expect(options.map(({ label }) => label)).toEqual([
      "Codex / Fast",
      "Codex / Reasoning",
      "Cursor / Composer",
      "Grok / Grok Code",
      "OpenCode / Fast",
    ]);
    expect(defaultStackSelection(providers)).toEqual([
      options[1].value,
      options[2].value,
      options[3].value,
    ]);
  });

  it("duplicates a singleton selection and caps larger selections at six competitors", () => {
    const codex = runnable(provider("codex", "Codex"));
    const options = createStackOptions([codex]);
    const singleton = createCompetitors(defaultStackSelection([codex]), options);

    expect(singleton).toHaveLength(2);
    expect(singleton.map(({ harness, model, label }) => ({ harness, model, label }))).toEqual([
      { harness: "codex", model: "fast", label: "Codex / Fast" },
      { harness: "codex", model: "fast", label: "Codex / Fast" },
    ]);
    expect(new Set(singleton.map(({ id }) => id)).size).toBe(2);
    expect(new Set(singleton.map(({ color }) => color)).size).toBe(2);

    const crowded = createCompetitors(Array(7).fill(options[0].value), options);
    expect(crowded).toHaveLength(6);
    expect(() => createCompetitors([], options)).toThrow("Select at least one");
    expect(() => createCompetitors(["missing"], options)).toThrow("Unknown provider/model selection");
  });

  it("builds a cloned request with conventional defaults or explicit settings", () => {
    const stack = runnable(provider("codex", "Codex"));
    const competitors = createCompetitors(
      defaultStackSelection([stack]),
      createStackOptions([stack]),
    );

    const defaults = createBenchmarkRequest(competitors);
    expect(defaults).toMatchObject({ type: "start", mode: "parallel", samplePreset: "standard" });
    expect(defaults.competitors).toEqual(competitors);
    expect(defaults.competitors).not.toBe(competitors);
    expect(defaults.competitors[0]).not.toBe(competitors[0]);

    expect(createBenchmarkRequest(competitors, {
      mode: "sequential",
      samplePreset: "quick",
    })).toMatchObject({ mode: "sequential", samplePreset: "quick" });
    expect(() => createBenchmarkRequest(competitors.slice(0, 1))).toThrow(RangeError);
  });
});

describe("TUI race domain", () => {
  const competitors: Competitor[] = [
    { id: "terminal-1", harness: "codex", model: "fast", label: "Codex / Fast", color: "cyan" },
    { id: "terminal-2", harness: "cursor", model: "fast", label: "Cursor / Fast", color: "magenta" },
  ];

  it("tracks a live lane while removing terminal controls from its output", () => {
    let race = createRaceState(competitors);
    race = reduceRaceEvent(race, {
      type: "benchmark.started",
      benchmarkId: "race-1",
      totalRuns: 4,
    }, 1_000);
    race = reduceRaceEvent(race, {
      type: "run.status",
      competitorId: "terminal-1",
      workload: "prose",
      sample: 1,
      warmup: false,
      status: "running",
    });
    race = reduceRaceEvent(race, {
      type: "run.delta",
      competitorId: "terminal-1",
      workload: "prose",
      sample: 1,
      text: "\u001b[31mRED\u001b[0m\r safe\u0000\u001b]0;owned\u0007",
      elapsedMs: 234,
      liveVisibleTokensPerSecond: 42.5,
    });

    expect(race).toMatchObject({
      phase: "running",
      benchmarkId: "race-1",
      totalRuns: 4,
      startedAt: 1_000,
    });
    expect(race.lanes["terminal-1"]).toMatchObject({
      status: "running",
      output: "RED safe",
      ttftMs: 234,
      liveTps: 42.5,
    });
  });

  it("deduplicates terminal events while distinguishing warmup and measured runs", () => {
    let race = createRaceState(competitors);
    race = reduceRaceEvent(race, {
      type: "benchmark.started",
      benchmarkId: "race-1",
      totalRuns: 3,
    });
    const complete = { type: "run.complete" as const, result: result("terminal-1") };
    race = reduceRaceEvent(race, complete);
    race = reduceRaceEvent(race, complete);

    for (const warmup of [true, false]) {
      const failure = {
        type: "run.error" as const,
        competitorId: "terminal-2",
        workload: "code" as const,
        sample: 1,
        warmup,
        message: warmup ? "warmup failed" : "measured failed",
      };
      race = reduceRaceEvent(race, failure);
      race = reduceRaceEvent(race, failure);
    }

    expect(race.completedRuns).toBe(3);
    expect(race.seenRuns.size).toBe(3);
    expect(race.results).toHaveLength(1);
    expect(race.issues.map(({ warmup }) => warmup)).toEqual([true, false]);
    expect(race.lanes["terminal-1"].completedRuns).toBe(1);
    expect(race.lanes["terminal-2"]).toMatchObject({
      completedRuns: 2,
      error: "measured failed",
    });
  });

  it("sorts final standings and represents cancellation and fatal errors explicitly", () => {
    const [first, second] = competitors;
    const summary = ([
      { competitor: first, finishRank: 2, disqualified: false },
      { competitor: second, finishRank: 1, disqualified: false },
    ] as Array<Pick<SummaryRow, "competitor" | "finishRank" | "disqualified">>).map((row) => ({
      measuredRuns: 2,
      validRuns: 2,
      anomalousRuns: 0,
      promptToFirstOutputMs: 100,
      coldStartToFirstOutputMs: 110,
      promptToFinishMs: 600,
      visibleTokensPerSecond: 100,
      crowns: [],
      ...row,
    })) as SummaryRow[];
    let race = reduceRaceEvent(createRaceState(competitors), {
      type: "benchmark.complete",
      results: [result(first.id), result(second.id)],
      summary,
    });

    expect(race.phase).toBe("complete");
    expect(race.summary.map(({ finishRank }) => finishRank)).toEqual([1, 2]);
    expect(reduceRaceEvent(race, { type: "benchmark.cancelled" }).phase).toBe("cancelled");

    race = reduceRaceEvent(race, { type: "error", message: "\u001b[31mbroken\u001b[0m" });
    expect(race).toMatchObject({ phase: "error", notice: "broken" });
  });
});
