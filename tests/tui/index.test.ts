import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type {
  HarnessId,
  ProviderInfo,
  RunResult,
  ServerEvent,
  SummaryRow,
} from "../../src/shared/types.js";
import type { HarnessAdapter } from "../../src/server/adapters/types.js";
import type { ProbedAdapter } from "../../src/terminal.js";
import {
  benchmarkRequestFromState,
  initialTuiState,
  reduceServerEvent,
  reduceTuiKey,
  renderTuiFrame,
  runTerminalTui,
  stripAnsi,
  supportsTerminalTui,
  visibleWidth,
  withProbeResults,
  type RenderTuiOptions,
  type TuiInput,
  type TuiOutput,
  type TuiState,
} from "../../src/tui/index.js";

class FakeTuiInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  readonly rawModes: boolean[] = [];
  resumeCount = 0;
  pauseCount = 0;

  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.rawModes.push(mode);
    return this;
  }

  override resume(): this {
    this.resumeCount += 1;
    return super.resume();
  }

  override pause(): this {
    this.pauseCount += 1;
    return super.pause();
  }

  press(key: { name?: string; sequence?: string; ctrl?: boolean }): void {
    this.emit("keypress", key.sequence ?? "", key);
  }
}

class FakeTuiOutput extends EventEmitter implements TuiOutput {
  readonly isTTY = true;
  columns = 100;
  rows = 30;
  windowSize: [number, number] | undefined;
  getWindowSizeCalls = 0;
  text = "";
  readonly writes: string[] = [];

  getWindowSize(): [number, number] {
    this.getWindowSizeCalls += 1;
    return this.windowSize ?? [this.columns, this.rows];
  }

  write(value: string): boolean {
    this.writes.push(value);
    this.text += value;
    return true;
  }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}

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
    models: [
      { id: "fast", label: "Fast" },
      { id: "balanced", label: "Balanced", isDefault: true },
      { id: "slow-reasoner", label: "Slow Reasoner" },
    ],
    ...overrides,
  };
}

function adapterFor(info: ProviderInfo): HarnessAdapter {
  return {
    id: info.id,
    name: info.name,
    command: info.command,
    async probe() {
      return info;
    },
    async run() {
      return {};
    },
  };
}

function setupState(): TuiState {
  const codex = provider("codex", "Codex");
  const cursor = provider("cursor", "Cursor", {
    models: [
      { id: "cursor-fast", label: "Cursor Fast", isDefault: true },
      { id: "cursor-deep", label: "Cursor Deep" },
    ],
  });
  const missing = provider("opencode", "OpenCode", {
    installed: false,
    authenticated: null,
    models: [],
    message: "not installed",
  });
  const probed: ProbedAdapter[] = [
    { adapter: adapterFor(codex), provider: codex },
    { adapter: adapterFor(cursor), provider: cursor },
    { adapter: adapterFor(missing), provider: missing },
  ];
  return withProbeResults(initialTuiState(), probed);
}

function completedResult(
  competitorId: string,
  overrides: Partial<RunResult> = {},
): RunResult {
  return {
    competitorId,
    workload: "prose",
    sample: 1,
    warmup: false,
    output: "visible output",
    valid: true,
    metrics: {
      harnessPrepMs: 25,
      promptToFirstOutputMs: 123,
      coldStartToFirstOutputMs: 148,
      visibleStreamMs: 1_000,
      promptToFinishMs: 1_123,
      visibleTokens: 60,
      visibleTokensPerSecond: 60,
      streamChunkCount: 3,
    },
    ...overrides,
  };
}

function summaryFor(state: TuiState): SummaryRow[] {
  return [
    {
      competitor: state.competitors[1],
      measuredRuns: 2,
      validRuns: 2,
      anomalousRuns: 0,
      disqualified: false,
      promptToFirstOutputMs: 90,
      coldStartToFirstOutputMs: 120,
      promptToFinishMs: 900,
      visibleTokensPerSecond: 75.2,
      finishRank: 1,
      crowns: ["finish", "firstOutput", "coldStart", "visibleSpeed"],
    },
    {
      competitor: state.competitors[0],
      measuredRuns: 2,
      validRuns: 2,
      anomalousRuns: 0,
      disqualified: false,
      promptToFirstOutputMs: 123,
      coldStartToFirstOutputMs: 148,
      promptToFinishMs: 1_123,
      visibleTokensPerSecond: 60,
      finishRank: 2,
      crowns: [],
    },
  ];
}

function render(state: TuiState, overrides: Partial<RenderTuiOptions> = {}): string {
  return renderTuiFrame(state, {
    columns: 100,
    rows: 30,
    color: false,
    now: 5_000,
    ...overrides,
  });
}

function expectFrameWithin(frame: string, columns: number, rows: number): void {
  const lines = frame.split("\n");
  expect(lines.length).toBeLessThanOrEqual(rows);
  for (const line of lines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
  }
}

function frameFromWrite(value: string): string {
  return value
    .replace(/^\u001b\[H/, "")
    .replace(/\u001b\[J$/, "")
    .split("\n")
    .map((line) => line.replace(/^\r\u001b\[2K/, ""))
    .join("\n");
}

describe("TUI setup and model picker", () => {
  it("turns probe results into a keyboard-editable two-lane starting grid", () => {
    let state = setupState();

    expect(state.view).toBe("setup");
    expect(state.competitors.map(({ harness, model }) => ({ harness, model }))).toEqual([
      { harness: "codex", model: "balanced" },
      { harness: "cursor", model: "cursor-fast" },
    ]);
    expect(state.unavailable).toHaveLength(1);

    state = reduceTuiKey(state, { name: "right" }).state;
    expect(state.competitors[0]).toMatchObject({
      harness: "cursor",
      model: "cursor-fast",
      label: "Cursor / Cursor Fast",
    });

    state = reduceTuiKey(state, { sequence: "m" }).state;
    state = reduceTuiKey(state, { sequence: "p" }).state;
    expect(state.mode).toBe("sequential");
    expect(state.preset).toBe("thorough");
  });

  it("adds and removes lanes within the two-to-six racer bounds", () => {
    let state = setupState();
    for (let index = 0; index < 8; index += 1) {
      state = reduceTuiKey(state, { sequence: "a" }).state;
    }
    expect(state.competitors).toHaveLength(6);
    expect(new Set(state.competitors.map(({ id }) => id)).size).toBe(6);

    for (let index = 0; index < 8; index += 1) {
      state = reduceTuiKey(state, { sequence: "d" }).state;
    }
    expect(state.competitors).toHaveLength(2);
    expect(state.selectedLane).toBeLessThan(2);
  });

  it("filters models as the user types and applies the selected match", () => {
    let state = setupState();
    state = reduceTuiKey(state, { name: "space", sequence: " " }).state;
    expect(state).toMatchObject({ view: "picker", picker: { row: 0, query: "", selected: 1, chosenId: "balanced" } });

    for (const character of "slow") {
      state = reduceTuiKey(state, { sequence: character }).state;
    }
    expect(state.picker?.query).toBe("slow");
    expect(render(state)).toContain("Slow Reasoner");
    expect(render(state).toLowerCase()).not.toContain("type to filter");

    state = reduceTuiKey(state, { name: "space", sequence: " " }).state;
    expect(state.view).toBe("picker");
    expect(state.picker?.chosenId).toBe("slow-reasoner");
    state = reduceTuiKey(state, { name: "return" }).state;
    expect(state.view).toBe("setup");
    expect(state.competitors[0]).toMatchObject({
      model: "slow-reasoner",
      label: "Codex / Slow Reasoner",
    });
  });

  it("builds the request and starts directly from the grid with Enter", () => {
    let state = setupState();
    state = reduceTuiKey(state, { sequence: "m" }).state;
    state = reduceTuiKey(state, { sequence: "p" }).state;

    expect(state.view).toBe("setup");
    expect(render(state)).toContain("normal model quota");
    const start = reduceTuiKey(state, { name: "return" });
    expect(start.effect).toEqual({ type: "start" });

    const request = benchmarkRequestFromState(state);
    expect(request).toMatchObject({
      type: "start",
      mode: "sequential",
      samplePreset: "thorough",
    });
    expect(request.competitors).toEqual(state.competitors);
    expect(request.competitors).not.toBe(state.competitors);
  });
});

describe("TUI race events", () => {
  it("tracks live heat data and strips terminal control sequences from output", () => {
    let state = setupState();
    const lane = state.competitors[0];
    state = reduceServerEvent(state, { type: "benchmark.started", benchmarkId: "race", totalRuns: 4 }, 1_000);
    state = reduceServerEvent(state, {
      type: "run.status",
      competitorId: lane.id,
      workload: "prose",
      sample: 1,
      warmup: false,
      status: "running",
    });
    state = reduceServerEvent(state, {
      type: "run.delta",
      competitorId: lane.id,
      workload: "prose",
      sample: 1,
      text: "\u001b[31mRED\u001b[0m\r safe\u0000\u001b]0;owned\u0007",
      elapsedMs: 234,
      liveVisibleTokensPerSecond: 42.5,
    });

    expect(state).toMatchObject({ view: "running", totalRuns: 4, startedAt: 1_000 });
    expect(state.lanes[lane.id]).toMatchObject({
      status: "running",
      workload: "prose",
      sample: 1,
      ttftMs: 234,
      liveTps: 42.5,
      output: "RED safe",
    });
    expect(state.lanes[lane.id].output).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("deduplicates repeated completions and errors", () => {
    let state = setupState();
    const [first, second] = state.competitors;
    state = reduceServerEvent(state, { type: "benchmark.started", benchmarkId: "race", totalRuns: 4 });
    const complete: ServerEvent = { type: "run.complete", result: completedResult(first.id) };
    state = reduceServerEvent(state, complete);
    state = reduceServerEvent(state, complete);

    expect(state.completedRuns).toBe(1);
    expect(state.results).toHaveLength(1);
    expect(state.lanes[first.id].completedRuns).toBe(1);

    state = reduceServerEvent(state, {
      type: "run.status",
      competitorId: second.id,
      workload: "code",
      sample: 1,
      warmup: true,
      status: "running",
    });
    const failed: ServerEvent = {
      type: "run.error",
      competitorId: second.id,
      workload: "code",
      sample: 1,
      message: "provider stopped",
    };
    state = reduceServerEvent(state, failed);
    state = reduceServerEvent(state, failed);

    expect(state.completedRuns).toBe(2);
    expect(state.lanes[second.id]).toMatchObject({
      status: "error",
      completedRuns: 1,
      error: "provider stopped",
    });
  });

  it("preserves line breaks and indentation in pane output", () => {
    let state = setupState();
    const lane = state.competitors[0];
    state = reduceServerEvent(state, { type: "benchmark.started", benchmarkId: "race", totalRuns: 4 }, 1_000);
    state = reduceServerEvent(state, {
      type: "run.delta",
      competitorId: lane.id,
      workload: "code",
      sample: 1,
      text: "function answer() {\n  return 42;\n}",
      elapsedMs: 100,
    });

    const frame = render(state, { columns: 120, rows: 24 });
    expect(state.lanes[lane.id].output).toBe("function answer() {\n  return 42;\n}");
    expect(frame).toContain("function answer() {");
    expect(frame).toContain("  return 42;");
  });

  it("sorts the final ranking and moves to results", () => {
    let state = setupState();
    const ranked = summaryFor(state).reverse();
    state = reduceServerEvent(state, {
      type: "benchmark.complete",
      results: [completedResult(state.competitors[0].id)],
      summary: ranked,
    });

    expect(state.view).toBe("results");
    expect(state.summary.map(({ finishRank }) => finishRank)).toEqual([1, 2]);
    expect(reduceTuiKey(state, { sequence: "r" }).effect).toEqual({ type: "start" });
    expect(reduceTuiKey(state, { sequence: "e" }).state.view).toBe("setup");
    expect(reduceTuiKey(state, { name: "return" }).effect).toEqual({ type: "exit", result: "completed" });
  });
});

describe("TUI rendering", () => {
  it("measures grapheme clusters using terminal cell widths", () => {
    expect(visibleWidth("✈️")).toBe(2);
    expect(visibleWidth("1️⃣")).toBe(2);
    expect(visibleWidth("👨‍👩‍👧‍👦")).toBe(2);
    expect(visibleWidth("e\u0301")).toBe(1);
    expect(visibleWidth("模型")).toBe(4);
  });

  it.each([60, 110])("renders the setup grid within a %i-column viewport", (columns) => {
    const frame = render(setupState(), { columns, rows: 24 });
    expect(frame).toContain("STARTING GRID");
    expect(frame).toContain("RACE SETUP");
    expect(frame).toContain("Research prose + Python");
    expect(frame).toContain("Codex");
    expect(frame).not.toContain("CHECK  RACE  FINISH");
    expect(frame).not.toContain("? help");
    expectFrameWithin(frame, columns, 24);
  });

  it("uses green readiness dots and a caret instead of a whole-row selection fill", () => {
    const frame = render(setupState(), { columns: 100, rows: 24, color: true });

    expect(frame).toContain("\u001b[38;5;114m●\u001b[0m Codex");
    expect(frame).toContain("\u001b[1;38;5;183m›\u001b[0m 01");
    expect(frame).not.toContain("\u001b[7m");
  });

  it("keeps every setup control visible in a short terminal", () => {
    let state = setupState();
    while (state.competitors.length < 6) state = reduceTuiKey(state, { sequence: "a" }).state;

    const frame = render(state, { columns: 48, rows: 14 });
    expect(frame).toContain("STARTING GRID");
    expect(frame).toContain("6 racers");
    expect(frame).toContain("normal model quota");
    expect(frame).toContain("Space models");
    expect(frame).toContain("Enter start");
    expectFrameWithin(frame, 48, 14);
  });

  it.each([60, 110])("renders live timing and sanitized output within a %i-column viewport", (columns) => {
    let state = setupState();
    const lane = state.competitors[0];
    state = reduceServerEvent(state, { type: "benchmark.started", benchmarkId: "race", totalRuns: 4 }, 1_000);
    state = reduceServerEvent(state, {
      type: "run.status",
      competitorId: lane.id,
      workload: "code",
      sample: 2,
      warmup: false,
      status: "running",
    });
    state = reduceServerEvent(state, {
      type: "run.delta",
      competitorId: lane.id,
      workload: "code",
      sample: 2,
      text: "hello \u001b[2Jworld from the selected lane",
      elapsedMs: 175,
      liveVisibleTokensPerSecond: 81.25,
    });
    const frame = render(state, { columns, rows: 24, now: 3_500 });

    expect(frame).toContain("LIVE · SAME GUN");
    expect(frame).toContain("code S2");
    if (columns >= 62) expect(frame).toContain("175ms");
    expect(frame).toContain("81.3");
    expect(frame).toContain("hello world");
    expect(frame).toContain("selected lane");
    expect(frame).toContain("Cursor / Cursor Fast");
    expect(frame).not.toContain("\u001b[2J");
    expectFrameWithin(frame, columns, 24);
  });

  it.each([2, 3, 4, 5, 6])("multiplexes all %i live outputs at once", (count) => {
    let state = setupState();
    while (state.competitors.length < count) state = reduceTuiKey(state, { sequence: "a" }).state;
    state = reduceServerEvent(state, { type: "benchmark.started", benchmarkId: "race", totalRuns: count * 2 }, 1_000);
    state.competitors.forEach((competitor, index) => {
      state = reduceServerEvent(state, {
        type: "run.status",
        competitorId: competitor.id,
        workload: index % 2 ? "code" : "prose",
        sample: 1,
        warmup: false,
        status: "running",
      });
      state = reduceServerEvent(state, {
        type: "run.delta",
        competitorId: competitor.id,
        workload: index % 2 ? "code" : "prose",
        sample: 1,
        text: `OUTPUT_LANE_${index + 1}`,
        elapsedMs: 100 + index,
        liveVisibleTokensPerSecond: 70 - index,
      });
    });

    for (const [columns, rows] of [[120, 32], [60, 24]] as const) {
      const frame = render(state, { columns, rows, now: 2_000 });
      state.competitors.forEach((competitor, index) => {
        expect(frame).toContain(competitor.label);
        expect(frame).toContain(`OUTPUT_LANE_${index + 1}`);
      });
      expectFrameWithin(frame, columns, rows);
    }
  });

  it.each([2, 3, 4, 5, 6])("keeps all %i live panes the same width", (count) => {
    let state = setupState();
    while (state.competitors.length < count) state = reduceTuiKey(state, { sequence: "a" }).state;
    state = reduceServerEvent(state, { type: "benchmark.started", benchmarkId: "race", totalRuns: count * 2 }, 1_000);

    for (const columns of [119, 120, 121]) {
      for (const color of [false, true]) {
        const frame = render(state, { columns, rows: 32, now: 2_000, color });
        const topBorder = frame.split("\n").map(stripAnsi).find((line) => line.includes("┌"));
        expect(topBorder).toBeDefined();
        const paneWidths = [...(topBorder ?? "").matchAll(/┌(─+)┐/g)].map((match) => visibleWidth(match[0]));
        expect(paneWidths.length).toBeGreaterThan(0);
        expect(Math.max(...paneWidths) - Math.min(...paneWidths)).toBeLessThanOrEqual(1);
        expect(paneWidths.reduce((total, width) => total + width, 0) + paneWidths.length - 1).toBe(columns);
      }
    }
  });

  it("uses lane, green status, and cyan metric colors on the live race", () => {
    let state = setupState();
    const lane = state.competitors[0];
    state = reduceServerEvent(state, { type: "benchmark.started", benchmarkId: "race", totalRuns: 4 }, 1_000);
    state = reduceServerEvent(state, {
      type: "run.delta",
      competitorId: lane.id,
      workload: "prose",
      sample: 1,
      text: "live output",
      elapsedMs: 150,
      liveVisibleTokensPerSecond: 70,
    });

    const frame = render(state, { columns: 120, rows: 24, color: true });
    expect(frame).toContain("\u001b[38;2;203;166;247m");
    expect(frame).toMatch(/\u001b\[38;5;114m prose S1 · [◐◓◑◒] STREAMING/);
    expect(frame).toContain("\u001b[38;5;117m FIRST 150ms · TOK/S 70.0");
  });

  it("marks an anomalous heat yellow instead of reporting a healthy finish", () => {
    let state = setupState();
    const lane = state.competitors[0];
    state = reduceServerEvent(state, { type: "benchmark.started", benchmarkId: "race", totalRuns: 4 }, 1_000);
    state = reduceServerEvent(state, {
      type: "run.complete",
      result: completedResult(lane.id, { valid: false, validationMessage: "missing required phrase" }),
    });

    expect(state.lanes[lane.id].status).toBe("invalid");
    const frame = render(state, { columns: 120, rows: 24, color: true });
    expect(frame).toContain("\u001b[38;5;221m prose S1 · ! ANOMALY");
    expect(frame).not.toContain("✓ HEAT DONE");
  });

  it("asks for more space instead of silently dropping live panes", () => {
    let state = setupState();
    while (state.competitors.length < 6) state = reduceTuiKey(state, { sequence: "a" }).state;
    state = reduceServerEvent(state, { type: "benchmark.started", benchmarkId: "race", totalRuns: 12 }, 1_000);

    const frame = render(state, { columns: 60, rows: 20, now: 2_000 });
    expect(frame).toContain("Resize to at least 24 rows");
    expect(frame).toContain("No racer will be hidden or collapsed");
    expectFrameWithin(frame, 60, 20);
  });

  it("either shows every output or an explicit resize screen across the layout matrix", () => {
    const viewports = [[60, 20], [60, 30], [60, 40], [80, 20], [80, 30], [100, 20], [120, 20]] as const;
    for (let count = 2; count <= 6; count += 1) {
      let state = setupState();
      while (state.competitors.length < count) state = reduceTuiKey(state, { sequence: "a" }).state;
      state = reduceServerEvent(state, { type: "benchmark.started", benchmarkId: "race", totalRuns: count * 2 }, 1_000);
      state.competitors.forEach((competitor, index) => {
        state = reduceServerEvent(state, {
          type: "run.delta",
          competitorId: competitor.id,
          workload: "prose",
          sample: 1,
          text: `MATRIX_OUTPUT_${index + 1}`,
          elapsedMs: 100,
        });
      });

      for (const [columns, rows] of viewports) {
        const frame = render(state, { columns, rows, now: 2_000 });
        if (frame.includes("Resize to at least")) {
          expect(frame).toContain("No racer will be hidden or collapsed");
          expect(frame).not.toContain("┌");
        } else {
          state.competitors.forEach((_competitor, index) => {
            expect(frame).toContain(`MATRIX_OUTPUT_${index + 1}`);
          });
        }
        expectFrameWithin(frame, columns, rows);
      }
    }
  });

  it.each([60, 110])("renders ranked results within a %i-column viewport", (columns) => {
    let state = setupState();
    const winnerId = state.competitors[1].id;
    const runnerId = state.competitors[0].id;
    const series = (
      competitorId: string,
      workload: "prose" | "code",
      totals: number[],
      ttftMs: number,
      visibleTokensPerSecond: number,
    ) => totals.map((promptToFinishMs, index) => completedResult(competitorId, {
      workload,
      sample: index + 1,
      metrics: {
        ...completedResult(competitorId).metrics,
        promptToFinishMs,
        promptToFirstOutputMs: ttftMs,
        visibleTokensPerSecond,
      },
    }));
    state = reduceServerEvent(state, {
      type: "benchmark.complete",
      results: [
        ...series(winnerId, "prose", [800, 850, 900], 80, 76),
        ...series(winnerId, "code", [900, 950, 1_000], 100, 74),
        ...series(runnerId, "prose", [1_000, 1_100, 1_123], 123, 60),
        ...series(runnerId, "code", [1_123, 1_200, 1_300], 123, 60),
      ],
      summary: summaryFor(state).map((row) => ({ ...row, measuredRuns: 6, validRuns: 6 })),
    });
    const frame = render(state, { columns, rows: 24 });

    expect(frame).toContain("RESULTS · STANDARD");
    expect(frame).toContain("12/12 VALID");
    expect(frame).toContain("WINNER");
    expect(frame).toContain("WON BY 223ms");
    expect(frame).toContain("Cursor / Cursor Fast");
    expect(frame).toContain("75.2");
    expect(frame.toUpperCase()).toContain("PROSE");
    expect(frame.toUpperCase()).toContain("CODE");
    expect(frame).toContain("850ms (800ms–900ms)");
    expect(frame).toContain("950ms (900ms–1.00s)");
    expect(frame).toContain("┌─ DETAILS · P1");
    expect(frame).toContain("│");
    expect(frame).toContain("└");
    const resultLines = frame.split("\n").map(stripAnsi);
    const classificationHeader = resultLines.findIndex((line) => line.includes("PL RACER"));
    const cardTop = resultLines.findIndex((line) => line.startsWith("┌─ DETAILS"));
    const cardBottom = resultLines.findIndex((line) => line.startsWith("└"));
    const controls = resultLines.findIndex((line) => line.includes("Q quit"));
    const cardRows = resultLines.slice(cardTop + 1, cardBottom);
    expect(resultLines[classificationHeader - 1]).toBe("");
    expect(resultLines[cardTop - 1]).toBe("");
    expect(resultLines[cardBottom + 1]).toBe("");
    expect(controls).toBe(cardBottom + 2);
    expect(cardRows.filter((line) => /^│\s*│$/.test(line)).length).toBeGreaterThanOrEqual(1);
    if (columns >= 100) {
      expect(frame).toContain("COLD");
      expect(frame).toContain("FINISH MED (MIN–MAX)");
      expect(frame).toContain("PREP");
      expect(frame).toContain("STREAM");
      expect(frame).toContain("CHUNKS");
    }
    const runnerFrame = render(reduceTuiKey(state, { name: "down" }).state, { columns, rows: 24 });
    expect(runnerFrame).toContain("+223ms (24.8%) TO P1");
    expectFrameWithin(frame, columns, 24);
    expectFrameWithin(runnerFrame, columns, 24);
  });

  it("color codes only the podium and DNF place cells", () => {
    let state = setupState();
    while (state.competitors.length < 4) state = reduceTuiKey(state, { sequence: "a" }).state;
    const podium: SummaryRow[] = [
      ...summaryFor(state),
      {
        competitor: state.competitors[2],
        measuredRuns: 1,
        validRuns: 1,
        anomalousRuns: 0,
        disqualified: false,
        promptToFirstOutputMs: 200,
        coldStartToFirstOutputMs: 250,
        promptToFinishMs: 1_500,
        visibleTokensPerSecond: 50,
        finishRank: 3,
        crowns: [],
      },
    ];
    state = reduceServerEvent(state, {
      type: "benchmark.complete",
      results: [],
      summary: podium,
    });

    const frame = render(state, { columns: 110, rows: 24, color: true });
    expect(frame).toContain("\u001b[1;38;5;220m P1\u001b[0m");
    expect(frame).toContain("\u001b[1;38;5;250m P2\u001b[0m");
    expect(frame).toContain("\u001b[1;38;5;173m P3\u001b[0m");
    expect(frame).toContain("\u001b[38;5;203mDNF\u001b[0m");
    expect(frame).not.toContain("\u001b[7m");
    expectFrameWithin(frame, 110, 24);
  });

  it("sorts disqualified racers last and keeps their anomalous measurements inspectable", () => {
    let state = setupState();
    const winner = { ...summaryFor(state)[0], measuredRuns: 2, validRuns: 2 };
    const disqualified: SummaryRow = {
      competitor: state.competitors[0],
      measuredRuns: 2,
      validRuns: 0,
      anomalousRuns: 2,
      disqualified: true,
      promptToFirstOutputMs: 123,
      coldStartToFirstOutputMs: 148,
      promptToFinishMs: 1_123,
      visibleTokensPerSecond: 60,
      finishRank: 0,
      crowns: [],
    };
    state = reduceServerEvent(state, {
      type: "benchmark.complete",
      results: [completedResult(disqualified.competitor.id, {
        valid: false,
        validationMessage: "Output arrived in a 2ms burst",
      })],
      summary: [disqualified, winner],
    });

    expect(state.summary.map((row) => row.competitor.id)).toEqual([
      winner.competitor.id,
      disqualified.competitor.id,
    ]);
    state = reduceTuiKey(state, { name: "down" }).state;
    const frame = render(state, { columns: 110, rows: 24, color: true });
    expect(frame).toContain("\u001b[38;5;203mDSQ\u001b[0m");
    expect(frame).toContain("\u001b[38;5;221m 0/2!\u001b[0m");
    expect(frame).not.toContain("P0");
    expect(frame).toContain("DETAILS · DSQ Codex / Balanced · ALL 2 RUNS ANOMALOUS");
    expect(frame).toContain("ANOMALY · prose S1 · Output arrived in a 2ms burst");
    expect(frame).toContain("RECORDED · NOT RANKED");
    expect(frame).toContain("1.12s");
    expectFrameWithin(frame, 110, 24);
  });

  it("flags a partial anomaly without disqualifying the eligible racer", () => {
    let state = setupState();
    const flagged = {
      ...summaryFor(state)[0],
      measuredRuns: 2,
      validRuns: 1,
      anomalousRuns: 1,
      disqualified: false,
    };
    state = reduceServerEvent(state, {
      type: "benchmark.complete",
      results: [
        completedResult(flagged.competitor.id),
        completedResult(flagged.competitor.id, {
          sample: 2,
          valid: false,
          validationMessage: "Output arrived in a 3ms burst",
        }),
      ],
      summary: [flagged, summaryFor(state)[1]],
    });

    const frame = render(state, { columns: 110, rows: 24, color: true });
    expect(frame).toContain("DETAILS · P1 Cursor / Cursor Fast · LEADER");
    expect(frame).toContain("\u001b[38;5;221m 1/2!\u001b[0m");
    expect(frame).toContain("ANOMALY · prose S2 · Output arrived in a 3ms burst");
    expect(frame).not.toContain("RECORDED · NOT RANKED");
    expect(frame).not.toContain("DSQ Cursor / Cursor Fast");
    expectFrameWithin(frame, 110, 24);
  });

  it("shows no eligible finisher when every measured racer is disqualified", () => {
    let state = setupState();
    const summary: SummaryRow[] = state.competitors.map((competitor) => ({
      competitor,
      measuredRuns: 1,
      validRuns: 0,
      anomalousRuns: 1,
      disqualified: true,
      promptToFirstOutputMs: 123,
      coldStartToFirstOutputMs: 148,
      promptToFinishMs: 1_123,
      visibleTokensPerSecond: 60,
      finishRank: 0,
      crowns: [],
    }));
    state = reduceServerEvent(state, {
      type: "benchmark.complete",
      results: state.competitors.map((competitor) => completedResult(competitor.id, {
        valid: false,
        validationMessage: "stream burst",
      })),
      summary,
    });

    const frame = render(state, { columns: 110, rows: 24 });
    expect(frame).toContain("NO ELIGIBLE FINISHERS");
    expect(frame).not.toContain(" WINNER ");
    expect(frame).not.toContain("P0");
    expect(frame.match(/DSQ/g)).toHaveLength(state.competitors.length + 1);
    state.competitors.forEach((competitor) => expect(frame).toContain(competitor.label));
    expectFrameWithin(frame, 110, 24);
  });

  it("keeps zero-valid racers visible as inspectable DNF entries", () => {
    let state = setupState();
    while (state.competitors.length < 6) state = reduceTuiKey(state, { sequence: "a" }).state;
    const dnf = state.competitors[0];
    const winner = { ...summaryFor(state)[0], validRuns: 1 };
    state = reduceServerEvent(state, { type: "benchmark.started", benchmarkId: "race", totalRuns: 12 });
    state = reduceServerEvent(state, {
      type: "run.error",
      competitorId: dnf.id,
      workload: "code",
      sample: 2,
      message: "\u001b[2Jprovider\nstopped",
    });
    state = reduceServerEvent(state, {
      type: "benchmark.complete",
      results: [],
      summary: [winner],
    });
    state = reduceTuiKey(state, { name: "down" }).state;

    const frame = render(state, { columns: 110, rows: 24 });
    expect(frame).toContain("DNF");
    expect(frame).toContain("DNF Codex / Balanced · NO RESULTS");
    expect(frame).toContain("ERROR · code S2 · provider stopped");
    expect(frame).toContain("NO RESULT · 6 measured runs");
    expect(frame).not.toContain("\u001b[2J");
    expectFrameWithin(frame, 110, 24);

    const shortFrame = render(state, { columns: 48, rows: 14 });
    expect(shortFrame).toContain("ERROR");
    expect(shortFrame).toContain("NO RESULT");
    expect(shortFrame).toContain("Q quit");
    const shortLines = shortFrame.split("\n");
    for (const label of ["ERROR", "NO RESULT"]) {
      const line = shortLines.find((candidate) => candidate.startsWith("│") && candidate.includes(label));
      expect(line?.startsWith("│")).toBe(true);
      expect(line?.endsWith("│")).toBe(true);
    }
    expect(shortLines.some((line) => line.startsWith("┌─ DETAILS"))).toBe(true);
    expect(shortLines.findIndex((line) => line.startsWith("└"))).toBeLessThan(shortLines.findIndex((line) => line.includes("Q quit")));
    expectFrameWithin(shortFrame, 48, 14);
  });

  it("still classifies every racer when no measured results are returned", () => {
    let state = setupState();
    state = reduceServerEvent(state, {
      type: "benchmark.complete",
      results: [],
      summary: [],
    });

    const frame = render(state, { columns: 110, rows: 24 });
    expect(frame).toContain("NO ELIGIBLE FINISHERS");
    expect(frame.match(/DNF/g)).toHaveLength(state.competitors.length + 1);
    state.competitors.forEach((competitor) => expect(frame).toContain(competitor.label));
    expectFrameWithin(frame, 110, 24);
  });

  it.each(["quick", "standard", "thorough"] as const)("shows the actual measured-run denominator for the %s preset", (preset) => {
    let state = { ...setupState(), preset };
    state = reduceServerEvent(state, {
      type: "benchmark.complete",
      results: [],
      summary: summaryFor(state),
    });

    const frame = render(state, { columns: 110, rows: 24 });
    expect(frame).toContain("2/2");
  });

  it("keeps detailed results and quit controls visible across layout breakpoints", () => {
    let state = setupState();
    const winnerId = state.competitors[1].id;
    state = reduceServerEvent(state, {
      type: "benchmark.complete",
      results: [
        completedResult(winnerId, { workload: "prose" }),
        completedResult(winnerId, { workload: "code" }),
      ],
      summary: summaryFor(state),
    });

    for (const columns of [48, 60, 75, 76, 99, 100, 110, 140]) {
      for (const rows of [14, 18, 24]) {
        const frame = render(state, { columns, rows });
        expect(frame).toContain("Q quit");
        const cardLines = frame.split("\n").filter((line) => /^[┌│└]/.test(stripAnsi(line)));
        expect(cardLines.length).toBeGreaterThanOrEqual(3);
        for (const line of cardLines) expect(visibleWidth(line)).toBe(Math.min(columns, 120));
        expectFrameWithin(frame, columns, rows);
      }
    }
  });

  it("keeps condensed workload metrics useful with six racers", () => {
    let state = { ...setupState(), preset: "quick" as const };
    while (state.competitors.length < 6) state = reduceTuiKey(state, { sequence: "a" }).state;
    const winner = { ...summaryFor(state)[0], validRuns: 2 };
    state = reduceServerEvent(state, {
      type: "benchmark.complete",
      results: [
        completedResult(winner.competitor.id, { workload: "prose" }),
        completedResult(winner.competitor.id, { workload: "code" }),
      ],
      summary: [winner],
    });

    const shortest = render(state, { columns: 48, rows: 14 });
    for (const workload of ["PROSE", "CODE"]) {
      const line = shortest.split("\n").find((candidate) => candidate.includes(workload));
      expect(line).toContain("FIRST");
      expect(line).toContain("TOK/S");
    }
    expectFrameWithin(shortest, 48, 14);

    const roomier = render(state, { columns: 60, rows: 18 });
    expect(roomier).toContain("PREP");
    expect(roomier).toContain("STREAM");
    expect(roomier).toContain("CHUNKS");
    expectFrameWithin(roomier, 60, 18);
  });

  it("uses a resize-safe fallback for very small terminals", () => {
    const frame = render(setupState(), { columns: 36, rows: 6 });
    expect(frame).toContain("Resize the terminal");
    expectFrameWithin(frame, 36, 6);
  });
});

describe("supportsTerminalTui", () => {
  const capableInput = { isTTY: true, setRawMode() {} } as unknown as TuiInput;
  const capableOutput = { isTTY: true, write() {} } satisfies TuiOutput;

  it("requires two TTYs, raw-mode support, and a non-dumb terminal", () => {
    expect(supportsTerminalTui(capableInput, capableOutput, "xterm-256color")).toBe(true);
    expect(supportsTerminalTui({ ...capableInput, isTTY: false } as TuiInput, capableOutput, "xterm")).toBe(false);
    expect(supportsTerminalTui(capableInput, { ...capableOutput, isTTY: false }, "xterm")).toBe(false);
    expect(supportsTerminalTui({ isTTY: true } as TuiInput, capableOutput, "xterm")).toBe(false);
    expect(supportsTerminalTui(capableInput, capableOutput, "dumb")).toBe(false);
  });
});

describe("terminal TUI lifecycle", () => {
  it("calibrates live pane widths against a fragmented terminal cursor report", async () => {
    const codex = provider("codex", "Codex");
    const cursor = provider("cursor", "Cursor", {
      models: [{ id: "cursor-fast", label: "Cursor Fast", isDefault: true }],
    });
    const adapters = [adapterFor(codex), adapterFor(cursor)];
    const input = new FakeTuiInput();
    const output = new FakeTuiOutput();
    output.columns = 137;
    output.rows = 30;
    output.windowSize = [137, 30];
    let signalRunnerStarted!: () => void;
    const runnerStarted = new Promise<void>((resolve) => {
      signalRunnerStarted = resolve;
    });
    let settleRunner!: () => void;
    const runnerSettlement = new Promise<void>((resolve) => {
      settleRunner = resolve;
    });

    const running = runTerminalTui({
      adapters,
      probeAdapters: async () => adapters.map((adapter, index) => ({
        adapter,
        provider: index === 0 ? codex : cursor,
      })),
      async runBenchmark(request, _adapters, _signal, emit) {
        emit({ type: "benchmark.started", benchmarkId: "race", totalRuns: 4 });
        request.competitors.forEach((competitor, index) => emit({
          type: "run.delta",
          competitorId: competitor.id,
          workload: index % 2 ? "code" : "prose",
          sample: 1,
          text: `CALIBRATED_OUTPUT_${index + 1}`,
          elapsedMs: 100,
          liveVisibleTokensPerSecond: 70 - index,
        }));
        signalRunnerStarted();
        await runnerSettlement;
      },
      input,
      output,
      handleSigint: false,
      color: true,
    });

    await waitFor(() => output.text.includes("STARTING GRID"), "setup screen was not rendered");
    input.write(Buffer.from("\u001b[24;"));
    input.write(Buffer.from("83R"));
    await waitFor(() => {
      const frame = frameFromWrite(output.writes.at(-1) ?? "");
      const selected = frame.split("\n").map(stripAnsi).find((line) => line.startsWith("›"));
      return selected !== undefined && visibleWidth(selected) === 83;
    }, "cursor report was not applied");
    input.press({ name: "return", sequence: "\r" });
    await runnerStarted;
    input.write(Buffer.from("\u001b[24;83R"));
    await waitFor(() => frameFromWrite(output.writes.at(-1) ?? "").includes("CALIBRATED_OUTPUT_2"), "calibrated live frame was not rendered");

    const frame = frameFromWrite(output.writes.at(-1) ?? "");
    const topBorder = frame.split("\n").map(stripAnsi).find((line) => line.includes("┌"));
    const paneWidths = [...(topBorder ?? "").matchAll(/┌(─+)┐/g)].map((match) => visibleWidth(match[0]));
    expect(output.text).toContain("\u001b[18t");
    expect(paneWidths).toEqual([41, 41]);
    expect(paneWidths.reduce((total, width) => total + width, 0) + 1).toBe(83);
    expectFrameWithin(frame, 83, 30);

    const writesBeforeResize = output.writes.length;
    const probesBeforeResize = output.writes.filter((value) => value.includes("\u001b[18t")).length;
    output.emit("resize");
    output.emit("resize");
    input.write(Buffer.from("\u001b[24;83R"));
    await waitFor(
      () => output.writes.filter((value) => value.includes("\u001b[18t")).length >= probesBeforeResize + 2,
      "queued resize probe was not started",
    );
    expect(output.writes.slice(writesBeforeResize).some((value) => value.startsWith("\u001b[H"))).toBe(false);
    input.write(Buffer.from("\u001b[24;79R"));
    await waitFor(() => {
      const resized = frameFromWrite(output.writes.at(-1) ?? "");
      const border = resized.split("\n").map(stripAnsi).find((line) => line.includes("┌"));
      const widths = [...(border ?? "").matchAll(/┌(─+)┐/g)].map((match) => visibleWidth(match[0]));
      return widths.length === 2 && widths.every((width) => width === 39);
    }, "resized terminal grid was not applied");

    input.press({ name: "c", sequence: "\u0003", ctrl: true });
    settleRunner();
    await expect(running).resolves.toBe("cancelled");
  });

  it("falls back to the reported PTY dimensions when the terminal does not answer", async () => {
    const info = provider("codex", "Codex");
    const adapter = adapterFor(info);
    const input = new FakeTuiInput();
    const output = new FakeTuiOutput();
    output.columns = 137;
    output.rows = 30;
    output.windowSize = [137, 30];

    const running = runTerminalTui({
      adapters: [adapter],
      probeAdapters: async () => [{ adapter, provider: info }],
      async runBenchmark() {},
      input,
      output,
      handleSigint: false,
      color: false,
    });

    await waitFor(() => output.text.includes("STARTING GRID"), "setup screen was not rendered");
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    const frame = frameFromWrite(output.writes.at(-1) ?? "");
    const selected = frame.split("\n").map(stripAnsi).find((line) => line.startsWith("›"));
    expect(selected).toBeDefined();
    expect(visibleWidth(selected ?? "")).toBe(137);
    input.press({ name: "q", sequence: "q" });
    await expect(running).resolves.toBe("declined");
  });

  it("uses the terminal text-area report when cursor reporting is unavailable", async () => {
    const info = provider("codex", "Codex");
    const adapter = adapterFor(info);
    const input = new FakeTuiInput();
    const output = new FakeTuiOutput();
    output.columns = 137;
    output.rows = 30;
    output.windowSize = [137, 30];

    const running = runTerminalTui({
      adapters: [adapter],
      probeAdapters: async () => [{ adapter, provider: info }],
      async runBenchmark() {},
      input,
      output,
      handleSigint: false,
      color: false,
    });

    await waitFor(() => output.text.includes("STARTING GRID"), "setup screen was not rendered");
    input.write(Buffer.from("\u001b[8;24;83t"));
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    const frame = frameFromWrite(output.writes.at(-1) ?? "");
    const selected = frame.split("\n").map(stripAnsi).find((line) => line.startsWith("›"));
    expect(selected).toBeDefined();
    expect(visibleWidth(selected ?? "")).toBe(83);
    input.press({ name: "q", sequence: "q" });
    await expect(running).resolves.toBe("declined");
  });

  it("prefers the live PTY window size over stale cached dimensions", async () => {
    const info = provider("codex", "Codex");
    const adapter = adapterFor(info);
    const input = new FakeTuiInput();
    const output = new FakeTuiOutput();
    output.columns = 220;
    output.rows = 60;
    output.windowSize = [36, 6];

    const running = runTerminalTui({
      adapters: [adapter],
      probeAdapters: async () => [{ adapter, provider: info }],
      async runBenchmark() {},
      input,
      output,
      handleSigint: false,
      color: false,
    });

    await waitFor(() => output.text.includes("Resize the terminal"), "fresh PTY dimensions were not used");
    expect(output.getWindowSizeCalls).toBeGreaterThan(0);
    input.press({ name: "q", sequence: "q" });
    await expect(running).resolves.toBe("declined");
  });

  it("returns declined from setup and restores the terminal screen and raw mode", async () => {
    const info = provider("codex", "Codex");
    const adapter = adapterFor(info);
    const input = new FakeTuiInput();
    const output = new FakeTuiOutput();
    let benchmarkRuns = 0;

    const running = runTerminalTui({
      adapters: [adapter],
      probeAdapters: async () => [{ adapter, provider: info }],
      async runBenchmark() {
        benchmarkRuns += 1;
      },
      input,
      output,
      handleSigint: false,
      color: false,
    });

    await waitFor(() => output.text.includes("STARTING GRID"), "setup screen was not rendered");
    input.press({ name: "q", sequence: "q" });

    await expect(running).resolves.toBe("declined");
    expect(benchmarkRuns).toBe(0);
    expect(input.rawModes).toEqual([true, false]);
    expect(input.isRaw).toBe(false);
    expect(input.resumeCount).toBeGreaterThanOrEqual(1);
    expect(input.pauseCount).toBeGreaterThanOrEqual(1);
    expect(output.text).toContain("\u001b[?1049h");
    expect(output.text).toContain("\u001b[?25l");
    expect(output.text).toContain("\u001b[?25h");
    expect(output.text.endsWith("\u001b[?1049l")).toBe(true);
  });

  it("aborts a pending benchmark once and waits for its settlement before returning cancelled", async () => {
    const info = provider("codex", "Codex");
    const adapter = adapterFor(info);
    const input = new FakeTuiInput();
    const output = new FakeTuiOutput();
    let signalRunnerStarted!: () => void;
    const runnerStarted = new Promise<void>((resolve) => {
      signalRunnerStarted = resolve;
    });
    let settleRunner!: () => void;
    const runnerSettlement = new Promise<void>((resolve) => {
      settleRunner = resolve;
    });
    let abortCount = 0;

    const running = runTerminalTui({
      adapters: [adapter],
      probeAdapters: async () => [{ adapter, provider: info }],
      async runBenchmark(_request, _adapters, signal, emit) {
        signal.addEventListener("abort", () => {
          abortCount += 1;
        }, { once: true });
        emit({ type: "benchmark.started", benchmarkId: "race", totalRuns: 4 });
        signalRunnerStarted();
        await runnerSettlement;
      },
      input,
      output,
      handleSigint: false,
      color: false,
    });
    let outcomeSettled = false;
    void running.then(() => {
      outcomeSettled = true;
    });

    await waitFor(() => output.text.includes("STARTING GRID"), "setup screen was not rendered");
    input.press({ name: "return", sequence: "\r" });
    await runnerStarted;

    input.press({ name: "c", sequence: "\u0003", ctrl: true });
    input.press({ name: "c", sequence: "\u0003", ctrl: true });
    await waitFor(() => abortCount === 1, "runner did not receive cancellation");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(abortCount).toBe(1);
    expect(outcomeSettled).toBe(false);
    expect(output.text).toContain("CANCELLING");

    settleRunner();
    await expect(running).resolves.toBe("cancelled");
    expect(input.rawModes).toEqual([true, false]);
    expect(output.text.endsWith("\u001b[?1049l")).toBe(true);
  });

  it("settles when a runner emits benchmark.cancelled and then resolves", async () => {
    const info = provider("codex", "Codex");
    const adapter = adapterFor(info);
    const input = new FakeTuiInput();
    const output = new FakeTuiOutput();

    const running = runTerminalTui({
      adapters: [adapter],
      probeAdapters: async () => [{ adapter, provider: info }],
      async runBenchmark(_request, _adapters, _signal, emit) {
        emit({ type: "benchmark.started", benchmarkId: "race", totalRuns: 4 });
        emit({ type: "benchmark.cancelled" });
      },
      input,
      output,
      handleSigint: false,
      color: false,
    });

    await waitFor(() => output.text.includes("STARTING GRID"), "setup screen was not rendered");
    input.press({ name: "return", sequence: "\r" });

    await expect(running).resolves.toBe("cancelled");
    expect(input.rawModes).toEqual([true, false]);
    expect(output.text.endsWith("\u001b[?1049l")).toBe(true);
  });
});
