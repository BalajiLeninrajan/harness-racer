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

    const completed = events.find((event) => event.type === "benchmark.complete");
    expect(completed?.type).toBe("benchmark.complete");
    if (completed?.type !== "benchmark.complete") return;
    expect(completed.results).toHaveLength(2);
    expect(completed.results.every((result) => result.competitorId === "healthy" && result.valid)).toBe(true);
    expect(completed.summary.map((row) => row.competitor.id)).toEqual(["healthy"]);
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
