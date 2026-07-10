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
      [fakeAdapter("codex", 1), fakeAdapter("cursor", 8)],
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
});
