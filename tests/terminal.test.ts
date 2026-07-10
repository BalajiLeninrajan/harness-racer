import { describe, expect, it } from "vitest";

import type {
  BenchmarkRequest,
  HarnessId,
  ProviderInfo,
  RunResult,
  ServerEvent,
  SummaryRow,
} from "../src/shared/types.js";
import type { HarnessAdapter } from "../src/server/adapters/types.js";
import {
  collectBenchmarkRequest,
  createTerminalEventRenderer,
  renderRankedSummary,
  runTerminalMode,
  type RunnableAdapter,
  type TerminalQuestioner,
  type TerminalWriter,
} from "../src/terminal.js";

class ScriptedQuestioner implements TerminalQuestioner {
  readonly prompts: string[] = [];
  closed = false;

  constructor(private readonly answers: string[]) {}

  async question(query: string): Promise<string> {
    this.prompts.push(query);
    const answer = this.answers.shift();
    if (answer === undefined) throw new Error(`No scripted answer for: ${query}`);
    return answer;
  }

  close(): void {
    this.closed = true;
  }
}

class BufferWriter implements TerminalWriter {
  text = "";

  write(value: string): boolean {
    this.text += value;
    return true;
  }
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
    ],
    ...overrides,
  };
}

function adapterFor(info: ProviderInfo, onProbe?: () => void): HarnessAdapter {
  return {
    id: info.id,
    name: info.name,
    command: info.command,
    async probe() {
      onProbe?.();
      return info;
    },
    async run() {
      return {};
    },
  };
}

function result(competitorId: string): RunResult {
  return {
    competitorId,
    workload: "prose",
    sample: 1,
    warmup: false,
    output: "visible benchmark output",
    valid: true,
    metrics: {
      harnessPrepMs: 20,
      promptToFirstOutputMs: 120,
      coldStartToFirstOutputMs: 140,
      visibleStreamMs: 1_000,
      promptToFinishMs: 1_120,
      visibleTokens: 50,
      visibleTokensPerSecond: 50,
      streamChunkCount: 2,
    },
  };
}

describe("terminal wizard", () => {
  it("builds a request with duplicate harnesses, default models, and explicit run settings", async () => {
    const codex = provider("codex", "Codex", { defaultModel: "balanced" });
    const cursor = provider("cursor", "Cursor");
    const runnable: RunnableAdapter[] = [
      { adapter: adapterFor(codex), provider: codex },
      { adapter: adapterFor(cursor), provider: cursor },
    ];
    const questioner = new ScriptedQuestioner([
      "2", // racer count
      "1", "", // Codex, its default model
      "1", "1", // Codex again, Fast
      "2", // sequential
      "3", // thorough
      "yes",
    ]);
    const writer = new BufferWriter();

    const request = await collectBenchmarkRequest(
      runnable,
      questioner,
      writer,
      new AbortController().signal,
    );

    expect(request).toMatchObject({ type: "start", mode: "sequential", samplePreset: "thorough" });
    expect(request?.competitors.map(({ harness, model }) => ({ harness, model }))).toEqual([
      { harness: "codex", model: "balanced" },
      { harness: "codex", model: "fast" },
    ]);
    expect(writer.text).toContain("a harness may be selected more than once");
    expect(writer.text).toContain("Balanced (default)");
  });
});

describe("terminal event rendering", () => {
  it("lists disqualified racers after eligible finishers without assigning place zero", () => {
    const competitors = [
      { id: "a", harness: "codex" as const, model: "fast", label: "Codex / Fast", color: "#fff" },
      { id: "b", harness: "cursor" as const, model: "balanced", label: "Cursor / Balanced", color: "#000" },
    ];
    const eligible: SummaryRow = {
      competitor: competitors[1],
      measuredRuns: 2,
      validRuns: 2,
      anomalousRuns: 0,
      disqualified: false,
      promptToFirstOutputMs: 90,
      coldStartToFirstOutputMs: 110,
      promptToFinishMs: 900,
      visibleTokensPerSecond: 72.4,
      finishRank: 1,
      crowns: ["finish"],
    };
    const disqualified: SummaryRow = {
      competitor: competitors[0],
      measuredRuns: 2,
      validRuns: 0,
      anomalousRuns: 2,
      disqualified: true,
      promptToFirstOutputMs: 120,
      coldStartToFirstOutputMs: 140,
      promptToFinishMs: 1_120,
      visibleTokensPerSecond: 50,
      finishRank: 0,
      crowns: [],
    };

    const output = renderRankedSummary([disqualified, eligible]);
    expect(output.indexOf("#1 Cursor / Balanced")).toBeLessThan(output.indexOf("DSQ Codex / Fast"));
    expect(output).toContain("0/2 valid, 2 anomalous runs");
    expect(output).not.toContain("#0");
    expect(renderRankedSummary([disqualified])).toContain("no eligible finishers");
  });

  it("omits streamed delta payloads and renders ranked final metrics", () => {
    const competitors = [
      { id: "a", harness: "codex" as const, model: "fast", label: "Codex / Fast", color: "#fff" },
      { id: "b", harness: "cursor" as const, model: "balanced", label: "Cursor / Balanced", color: "#000" },
    ];
    const writer = new BufferWriter();
    const render = createTerminalEventRenderer(writer, competitors);
    const firstResult = result("a");
    const summary: SummaryRow[] = [
      {
        competitor: competitors[1],
        measuredRuns: 2,
        validRuns: 2,
        anomalousRuns: 0,
        disqualified: false,
        promptToFirstOutputMs: 90,
        coldStartToFirstOutputMs: 110,
        promptToFinishMs: 900,
        visibleTokensPerSecond: 72.4,
        finishRank: 1,
        crowns: ["finish", "visibleSpeed"],
      },
      {
        competitor: competitors[0],
        measuredRuns: 2,
        validRuns: 2,
        anomalousRuns: 0,
        disqualified: false,
        promptToFirstOutputMs: 120,
        coldStartToFirstOutputMs: 140,
        promptToFinishMs: 1_120,
        visibleTokensPerSecond: 50,
        finishRank: 2,
        crowns: [],
      },
    ];

    const events: ServerEvent[] = [
      { type: "benchmark.started", benchmarkId: "bench", totalRuns: 2 },
      {
        type: "run.delta",
        competitorId: "a",
        workload: "prose",
        sample: 1,
        text: "SECRET_DELTA_PAYLOAD",
        elapsedMs: 100,
      },
      { type: "run.complete", result: firstResult },
      { type: "benchmark.complete", results: [firstResult], summary },
    ];
    events.forEach(render);

    expect(writer.text).not.toContain("SECRET_DELTA_PAYLOAD");
    expect(writer.text).toContain("[1/2] Codex / Fast");
    expect(writer.text).toContain("#1 Cursor / Balanced");
    expect(writer.text).toContain("90ms");
    expect(writer.text).toContain("72.4 visible tok/s");
    expect(writer.text.indexOf("#1 Cursor")).toBeLessThan(writer.text.indexOf("#2 Codex"));
  });

  it("labels failed warmups and resets progress for a reused renderer", () => {
    const competitor = { id: "a", harness: "codex" as const, model: "fast", label: "Codex / Fast", color: "#fff" };
    const writer = new BufferWriter();
    const render = createTerminalEventRenderer(writer, [competitor]);

    render({ type: "benchmark.started", benchmarkId: "first", totalRuns: 1 });
    render({
      type: "run.status",
      competitorId: "a",
      workload: "prose",
      sample: 1,
      warmup: true,
      status: "running",
    });
    render({ type: "run.error", competitorId: "a", workload: "prose", sample: 1, message: "failed" });
    render({ type: "benchmark.started", benchmarkId: "second", totalRuns: 1 });
    render({ type: "run.complete", result: result("a") });

    expect(writer.text).toContain("prose warmup — error: failed");
    expect(writer.text).not.toContain("[2/1]");
  });
});

describe("runTerminalMode", () => {
  it("probes adapters directly, filters unavailable providers, and runs only selected adapters", async () => {
    let codexProbes = 0;
    let cursorProbes = 0;
    const codex = provider("codex", "Codex");
    const cursor = provider("cursor", "Cursor", { authenticated: false });
    const codexAdapter = adapterFor(codex, () => { codexProbes += 1; });
    const cursorAdapter = adapterFor(cursor, () => { cursorProbes += 1; });
    const questioner = new ScriptedQuestioner([
      "", // defaults to two racers even with one runnable provider
      "", "", // first Codex/default model
      "", "", // second Codex/default model
      "", // parallel
      "1", // quick
      "", // confirm
    ]);
    const writer = new BufferWriter();
    let capturedRequest: BenchmarkRequest | undefined;
    let capturedAdapters: HarnessAdapter[] = [];

    const status = await runTerminalMode({
      adapters: [codexAdapter, cursorAdapter],
      questioner,
      output: writer,
      handleSigint: false,
      async runBenchmark(request, adapterList, _signal, emit) {
        expect(questioner.closed).toBe(true);
        capturedRequest = request;
        capturedAdapters = adapterList;
        emit({ type: "benchmark.started", benchmarkId: "bench", totalRuns: 4 });
        emit({ type: "benchmark.complete", results: [], summary: [] });
      },
    });

    expect(status).toBe("completed");
    expect(codexProbes).toBe(1);
    expect(cursorProbes).toBe(1);
    expect(capturedRequest?.competitors).toHaveLength(2);
    expect(capturedRequest?.competitors.every((competitor) => competitor.harness === "codex")).toBe(true);
    expect(capturedAdapters).toEqual([codexAdapter]);
    expect(writer.text).toContain("Cursor: not authenticated");
    expect(questioner.closed).toBe(true);
  });

  it("returns unavailable without prompting when no provider can run", async () => {
    const missing = provider("codex", "Codex", { installed: false, models: [] });
    const questioner = new ScriptedQuestioner([]);
    const writer = new BufferWriter();
    let ran = false;

    const status = await runTerminalMode({
      adapters: [adapterFor(missing)],
      questioner,
      output: writer,
      handleSigint: false,
      async runBenchmark() {
        ran = true;
      },
    });

    expect(status).toBe("unavailable");
    expect(ran).toBe(false);
    expect(questioner.prompts).toEqual([]);
    expect(questioner.closed).toBe(true);
    expect(writer.text).toContain("No runnable harnesses were found");
  });

  it("does not start provider probes for a pre-cancelled run", async () => {
    const codex = provider("codex", "Codex");
    const questioner = new ScriptedQuestioner([]);
    const writer = new BufferWriter();
    const external = new AbortController();
    let probes = 0;
    external.abort(new Error("already cancelled"));

    const status = await runTerminalMode({
      adapters: [adapterFor(codex, () => { probes += 1; })],
      questioner,
      output: writer,
      signal: external.signal,
      handleSigint: false,
    });

    expect(status).toBe("cancelled");
    expect(probes).toBe(0);
    expect(questioner.closed).toBe(true);
  });

  it("forwards an external abort to an active benchmark and cancels cleanly", async () => {
    const codex = provider("codex", "Codex");
    const questioner = new ScriptedQuestioner(["", "", "", "", "", "", "", ""]);
    const writer = new BufferWriter();
    const external = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let signalRunnerStarted!: () => void;
    const runnerStarted = new Promise<void>((resolve) => { signalRunnerStarted = resolve; });

    const running = runTerminalMode({
      adapters: [adapterFor(codex)],
      questioner,
      output: writer,
      signal: external.signal,
      handleSigint: false,
      async runBenchmark(_request, _adapterList, signal) {
        observedSignal = signal;
        signalRunnerStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });

    await runnerStarted;
    external.abort(new Error("stop now"));

    await expect(running).resolves.toBe("cancelled");
    expect(observedSignal?.aborted).toBe(true);
    expect(writer.text).toContain("Benchmark cancelled");
    expect(questioner.closed).toBe(true);
  });
});
