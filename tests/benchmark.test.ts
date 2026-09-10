import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessAdapter } from "../src/server/adapters/types.js";
import { runBenchmark } from "../src/server/benchmark.js";
import type { BenchmarkRequest, ServerEvent } from "../src/shared/types.js";

function fakeAdapter(id: "codex" | "cursor", delayMs: number): HarnessAdapter {
  return {
    id,
    name: id,
    command: id,
    async probe() {
      return { id, name: id, command: id, installed: true, authenticated: true, models: [] };
    },
    async run(input) {
      input.onReady();
      await input.waitForStart();
      const corpus = input.prompt.match(/<payload>\n([\s\S]*?)\n<\/payload>/)?.[1] ?? "";
      const middle = Math.floor(corpus.length / 2);
      input.onDelta(corpus.slice(0, middle));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      input.onDelta(corpus.slice(middle));
      return { nativeOutputTokens: 42 };
    },
  };
}

function corpusFrom(prompt: string): string {
  return prompt.match(/<payload>\n([\s\S]*?)\n<\/payload>/)?.[1] ?? "";
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => {
      const error = new Error("Benchmark cancelled");
      error.name = "AbortError";
      reject(error);
    };
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

// Streams half the payload, then behaves like a real adapter under cancellation:
// it rejects with its own fixed abort error once the run signal fires.
function stallingAdapter(id: "codex" | "cursor", onStalled?: () => void): HarnessAdapter {
  return {
    id,
    name: id,
    command: id,
    async probe() {
      return { id, name: id, command: id, installed: true, authenticated: true, models: [] };
    },
    async run(input) {
      input.onReady();
      await input.waitForStart();
      const corpus = corpusFrom(input.prompt);
      input.onDelta(corpus.slice(0, Math.floor(corpus.length / 2)));
      onStalled?.();
      return rejectOnAbort(input.signal);
    },
  };
}

function sequentialRequest(): BenchmarkRequest {
  return {
    type: "start",
    mode: "sequential",
    samplePreset: "quick",
    competitors: [{ id: "a", harness: "codex", model: "alpha", label: "Alpha", color: "#fff" }],
  };
}

function parallelRequest(): BenchmarkRequest {
  return {
    type: "start",
    mode: "parallel",
    samplePreset: "quick",
    competitors: [
      { id: "a", harness: "codex", model: "alpha", label: "Alpha", color: "#fff" },
      { id: "b", harness: "cursor", model: "beta", label: "Beta", color: "#000" },
    ],
  };
}

function failingAdapter(id: "codex" | "cursor", message: string): HarnessAdapter {
  return {
    id,
    name: id,
    command: id,
    async probe() {
      return { id, name: id, command: id, installed: true, authenticated: true, models: [] };
    },
    async run() {
      throw new Error(message);
    },
  };
}

describe("benchmark engine", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs both heats behind a parallel ready barrier and produces a ranking", async () => {
    const request: BenchmarkRequest = {
      type: "start",
      mode: "parallel",
      samplePreset: "quick",
      competitors: [
        { id: "a", harness: "codex", model: "alpha", label: "Alpha", color: "#fff" },
        { id: "b", harness: "cursor", model: "beta", label: "Beta", color: "#000" },
      ],
    };
    const events: ServerEvent[] = [];

    await runBenchmark(
      request,
      [fakeAdapter("codex", 60), fakeAdapter("cursor", 90)],
      new AbortController().signal,
      (event) => events.push(event),
    );

    const completed = events.find((event) => event.type === "benchmark.complete");
    expect(completed?.type).toBe("benchmark.complete");
    if (completed?.type !== "benchmark.complete") return;
    expect(completed.results).toHaveLength(4);
    expect(completed.results.every((result) => result.valid)).toBe(true);
    expect(completed.summary).toHaveLength(2);
    expect(completed.summary[0].competitor.id).toBe("a");
    expect(completed.summary[0].crowns).toContain("finish");
  });

  it("excludes responses delivered as a rapid callback burst", async () => {
    const request: BenchmarkRequest = {
      type: "start",
      mode: "sequential",
      samplePreset: "quick",
      competitors: [
        { id: "a", harness: "codex", model: "alpha", label: "Alpha", color: "#fff" },
      ],
    };
    const events: ServerEvent[] = [];

    await runBenchmark(
      request,
      [fakeAdapter("codex", 0)],
      new AbortController().signal,
      (event) => events.push(event),
    );

    const completed = events.find((event) => event.type === "benchmark.complete");
    expect(completed?.type).toBe("benchmark.complete");
    if (completed?.type !== "benchmark.complete") return;
    expect(completed.results).toHaveLength(2);
    expect(completed.results.every((result) => !result.valid)).toBe(true);
    expect(completed.results.every((result) => result.validationMessage?.includes("burst"))).toBe(true);
    expect(completed.summary).toHaveLength(1);
    expect(completed.summary[0]).toMatchObject({
      measuredRuns: 2,
      validRuns: 0,
      anomalousRuns: 2,
      disqualified: true,
      finishRank: 0,
      crowns: [],
    });
  });

  it("releases the parallel start barrier when a racer fails during setup", async () => {
    const request: BenchmarkRequest = {
      type: "start",
      mode: "parallel",
      samplePreset: "quick",
      competitors: [
        { id: "broken", harness: "codex", model: "alpha", label: "Broken", color: "#fff" },
        { id: "healthy", harness: "cursor", model: "beta", label: "Healthy", color: "#000" },
      ],
    };
    const events: ServerEvent[] = [];

    await runBenchmark(
      request,
      [failingAdapter("codex", "setup failed"), fakeAdapter("cursor", 60)],
      new AbortController().signal,
      (event) => events.push(event),
    );

    const errors = events.filter((event) => event.type === "run.error");
    expect(errors).toHaveLength(2);
    expect(errors.every((event) => event.competitorId === "broken" && event.message === "setup failed")).toBe(true);
    // The failure is reported when it happens, not after the slowest lane finishes.
    expect(events.findIndex((event) => event.type === "run.error"))
      .toBeLessThan(events.findIndex((event) => event.type === "run.complete"));

    const completed = events.find((event) => event.type === "benchmark.complete");
    expect(completed?.type).toBe("benchmark.complete");
    if (completed?.type !== "benchmark.complete") return;
    expect(completed.results).toHaveLength(2);
    expect(completed.results.every((result) => result.competitorId === "healthy" && result.valid)).toBe(true);
    expect(completed.summary.map((row) => row.competitor.id)).toEqual(["healthy"]);
  });

  it("rejects with the cancel reason when a parallel heat is cancelled", async () => {
    const controller = new AbortController();
    const events: ServerEvent[] = [];
    let stalled = 0;
    const onStalled = () => {
      stalled += 1;
      if (stalled === 2) controller.abort(new Error("Benchmark cancelled."));
    };

    await expect(runBenchmark(
      parallelRequest(),
      [stallingAdapter("codex", onStalled), stallingAdapter("cursor", onStalled)],
      controller.signal,
      (event) => events.push(event),
    )).rejects.toThrow("Benchmark cancelled.");

    expect(events.some((event) => event.type === "benchmark.complete")).toBe(false);
    expect(events.filter((event) => event.type === "run.error")).toEqual([]);
  });

  it("reports the timeout reason when a run stalls for 120 seconds", async () => {
    vi.useFakeTimers();
    const events: ServerEvent[] = [];
    let runs = 0;
    let stalled!: () => void;
    const firstRunStalled = new Promise<void>((resolve) => { stalled = resolve; });
    const adapter: HarnessAdapter = {
      ...stallingAdapter("codex"),
      async run(input) {
        runs += 1;
        input.onReady();
        await input.waitForStart();
        const corpus = corpusFrom(input.prompt);
        const middle = Math.floor(corpus.length / 2);
        input.onDelta(corpus.slice(0, middle));
        if (runs > 1) {
          input.onDelta(corpus.slice(middle));
          return {};
        }
        stalled();
        return rejectOnAbort(input.signal);
      },
    };

    const done = runBenchmark(sequentialRequest(), [adapter], new AbortController().signal, (event) => events.push(event));
    await firstRunStalled;
    await vi.advanceTimersByTimeAsync(120_000);
    await done;

    expect(events.filter((event) => event.type === "run.error")).toEqual([
      expect.objectContaining({ competitorId: "a", message: "Run timed out after 120 seconds." }),
    ]);
    const completed = events.find((event) => event.type === "benchmark.complete");
    expect(completed?.type).toBe("benchmark.complete");
    if (completed?.type !== "benchmark.complete") return;
    expect(completed.results).toHaveLength(1);
  });

  it("does not report a run complete when it was cancelled as the adapter resolved", async () => {
    const controller = new AbortController();
    const events: ServerEvent[] = [];
    const adapter: HarnessAdapter = {
      ...stallingAdapter("codex"),
      run(input) {
        const run = (async () => {
          input.onReady();
          await input.waitForStart();
          input.onDelta(corpusFrom(input.prompt));
          return {};
        })();
        // The cancel lands after the adapter settled but before the engine
        // looks at the result.
        void run.then(() => controller.abort(new Error("Benchmark cancelled.")));
        return run;
      },
    };

    await expect(runBenchmark(sequentialRequest(), [adapter], controller.signal, (event) => events.push(event)))
      .rejects.toThrow("Benchmark cancelled.");

    expect(events.some((event) => event.type === "run.complete")).toBe(false);
    expect(events.some((event) => event.type === "benchmark.complete")).toBe(false);
  });

  it("continues sequential heats after one racer fails", async () => {
    const request: BenchmarkRequest = {
      type: "start",
      mode: "sequential",
      samplePreset: "quick",
      competitors: [
        { id: "broken", harness: "codex", model: "alpha", label: "Broken", color: "#fff" },
        { id: "healthy", harness: "cursor", model: "beta", label: "Healthy", color: "#000" },
      ],
    };
    const events: ServerEvent[] = [];

    await runBenchmark(
      request,
      [failingAdapter("codex", "launch failed"), fakeAdapter("cursor", 60)],
      new AbortController().signal,
      (event) => events.push(event),
    );

    expect(events.filter((event) => event.type === "run.error")).toHaveLength(2);
    const completed = events.find((event) => event.type === "benchmark.complete");
    expect(completed?.type).toBe("benchmark.complete");
    if (completed?.type !== "benchmark.complete") return;
    expect(completed.results).toHaveLength(2);
    expect(completed.results.every((result) => result.competitorId === "healthy" && result.valid)).toBe(true);
  });
});
