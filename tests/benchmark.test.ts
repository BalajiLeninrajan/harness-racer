import { describe, expect, it } from "vitest";
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

describe("benchmark engine", () => {
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

  it("identifies warmup errors even when a heat fails before emitting status", async () => {
    const request: BenchmarkRequest = {
      type: "start",
      mode: "sequential",
      samplePreset: "standard",
      competitors: [
        { id: "a", harness: "codex", model: "alpha", label: "Alpha", color: "#fff" },
      ],
    };
    const events: ServerEvent[] = [];

    await runBenchmark(
      request,
      [],
      new AbortController().signal,
      (event) => events.push(event),
    );

    expect(events.some((event) => event.type === "run.status")).toBe(false);
    const errors = events.filter((event) => event.type === "run.error");
    expect(errors).toHaveLength(8);
    expect(errors.map((event) => event.warmup)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("does not report completion when a parallel heat is cancelled", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancelled by test");
    const cancellingAdapter = (id: "codex" | "cursor"): HarnessAdapter => ({
      id,
      name: id,
      command: id,
      async probe() {
        return { id, name: id, command: id, installed: true, authenticated: true, models: [] };
      },
      async run(input) {
        input.onReady();
        await input.waitForStart();
        controller.abort(cancellation);
        throw cancellation;
      },
    });
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

    await expect(
      runBenchmark(
        request,
        [cancellingAdapter("codex"), cancellingAdapter("cursor")],
        controller.signal,
        (event) => events.push(event),
      ),
    ).rejects.toBe(cancellation);
    expect(events.some((event) => event.type === "benchmark.complete")).toBe(false);
  });
});
