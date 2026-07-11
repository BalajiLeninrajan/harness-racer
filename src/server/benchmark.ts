import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BenchmarkRequest,
  Competitor,
  RunResult,
  SamplePreset,
  ServerEvent,
  WorkloadId,
} from "../shared/types.js";
import type { HarnessAdapter } from "./adapters/types.js";
import { countNormalizedTokens, streamAnomalyMessage, summarizeResults } from "./metrics.js";
import { validateOutput, workloads } from "./workloads.js";

const presetRuns: Record<SamplePreset, { warmups: number; measured: number }> = {
  quick: { warmups: 0, measured: 1 },
  standard: { warmups: 1, measured: 3 },
  thorough: { warmups: 1, measured: 5 },
};

type Emit = (event: ServerEvent) => void;

interface RunOneInput {
  competitor: Competitor;
  workload: (typeof workloads)[number];
  sample: number;
  warmup: boolean;
  adapter: HarnessAdapter;
  parentSignal: AbortSignal;
  emit: Emit;
  startGate?: Promise<void>;
  onReady?: () => void;
}

async function runOne(input: RunOneInput): Promise<RunResult> {
  const { competitor, workload, sample, warmup, adapter, parentSignal, emit } = input;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Run timed out after 120 seconds.")), 120_000);
  const abort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", abort, { once: true });

  const workspace = await mkdtemp(join(tmpdir(), "tps-racer-"));
  const launchedAt = performance.now();
  let readyAt = launchedAt;
  let startedAt = launchedAt;
  let firstDeltaAt = 0;
  let lastDeltaAt = 0;
  let output = "";
  let deltaCount = 0;

  emit({ type: "run.status", competitorId: competitor.id, workload: workload.id, sample, warmup, status: "starting" });

  try {
    const adapterResult = await adapter.run({
      model: competitor.model,
      prompt: workload.prompt,
      cwd: workspace,
      signal: controller.signal,
      onReady: () => {
        readyAt = performance.now();
        emit({ type: "run.status", competitorId: competitor.id, workload: workload.id, sample, warmup, status: "ready" });
        input.onReady?.();
      },
      waitForStart: async () => {
        if (input.startGate) await input.startGate;
        startedAt = performance.now();
        emit({ type: "run.status", competitorId: competitor.id, workload: workload.id, sample, warmup, status: "running" });
      },
      onDelta: (text) => {
        if (!text) return;
        const now = performance.now();
        if (firstDeltaAt === 0) firstDeltaAt = now;
        lastDeltaAt = now;
        deltaCount += 1;
        output += text;
        const visibleStreamMs = Math.max(1, now - firstDeltaAt);
        const tokens = countNormalizedTokens(output);
        emit({
          type: "run.delta",
          competitorId: competitor.id,
          workload: workload.id,
          sample,
          text,
          elapsedMs: now - startedAt,
          ...(deltaCount > 1 ? { liveVisibleTokensPerSecond: tokens / (visibleStreamMs / 1000) } : {}),
        });
      },
    });

    if (firstDeltaAt === 0 || lastDeltaAt === 0) {
      throw new Error("The agent completed without streaming visible text.");
    }

    const visibleTokens = countNormalizedTokens(output);
    const observedStreamMs = lastDeltaAt - firstDeltaAt;
    const visibleStreamMs = Math.max(1, observedStreamMs);
    const promptToFirstOutputMs = firstDeltaAt - startedAt;
    const validation = validateOutput(output, workload.corpus);
    const streamAnomaly = streamAnomalyMessage(deltaCount, observedStreamMs);
    const result: RunResult = {
      competitorId: competitor.id,
      workload: workload.id,
      sample,
      warmup,
      output,
      valid: validation.valid && streamAnomaly === undefined,
      ...(!validation.valid
        ? { validationMessage: validation.message }
        : streamAnomaly
          ? { validationMessage: streamAnomaly }
          : {}),
      metrics: {
        harnessPrepMs: readyAt - launchedAt,
        promptToFirstOutputMs,
        coldStartToFirstOutputMs: readyAt - launchedAt + promptToFirstOutputMs,
        visibleStreamMs,
        promptToFinishMs: lastDeltaAt - startedAt,
        visibleTokens,
        visibleTokensPerSecond: visibleTokens / (visibleStreamMs / 1000),
        ...(adapterResult.nativeOutputTokens !== undefined
          ? { nativeOutputTokens: adapterResult.nativeOutputTokens }
          : {}),
        streamChunkCount: deltaCount,
      },
    };

    emit({ type: "run.status", competitorId: competitor.id, workload: workload.id, sample, warmup, status: "complete" });
    emit({ type: "run.complete", result });
    return result;
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runParallel(
  competitors: Competitor[],
  workload: (typeof workloads)[number],
  sample: number,
  warmup: boolean,
  adapters: Map<string, HarnessAdapter>,
  signal: AbortSignal,
  emit: Emit,
): Promise<RunResult[]> {
  let readyCount = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const tasks = competitors.map((competitor) => {
      const adapter = adapters.get(competitor.harness);
      if (!adapter) throw new Error(`No adapter for ${competitor.harness}.`);
      return runOne({
        competitor,
        workload,
        sample,
        warmup,
        adapter,
        parentSignal: signal,
        emit,
        startGate: gate,
        onReady: () => {
          readyCount += 1;
          if (readyCount === competitors.length) release();
        },
      }).catch((error) => {
        // Never strand healthy racers behind the readiness barrier when one
        // process fails during setup.
        release();
        throw error;
      });
    });

  const settled = await Promise.allSettled(tasks);
  const results: RunResult[] = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
      return;
    }
    const competitor = competitors[index];
    emit({
      type: "run.error",
      competitorId: competitor.id,
      workload: workload.id,
      sample,
      warmup,
      message: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
    });
  });
  return results;
}

async function runSequential(
  competitors: Competitor[],
  workload: (typeof workloads)[number],
  sample: number,
  warmup: boolean,
  adapters: Map<string, HarnessAdapter>,
  signal: AbortSignal,
  emit: Emit,
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const competitor of competitors) {
    if (signal.aborted) throw signal.reason;
    const adapter = adapters.get(competitor.harness);
    if (!adapter) throw new Error(`No adapter for ${competitor.harness}.`);
    try {
      results.push(
        await runOne({ competitor, workload, sample, warmup, adapter, parentSignal: signal, emit }),
      );
    } catch (error) {
      if (signal.aborted) throw error;
      emit({
        type: "run.error",
        competitorId: competitor.id,
        workload: workload.id,
        sample,
        warmup,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export async function runBenchmark(
  request: BenchmarkRequest,
  adapterList: readonly HarnessAdapter[],
  signal: AbortSignal,
  emit: Emit,
): Promise<void> {
  const adapters = new Map(adapterList.map((adapter) => [adapter.id, adapter]));
  const preset = presetRuns[request.samplePreset];
  const totalSamples = preset.warmups + preset.measured;
  const totalRuns = totalSamples * workloads.length * request.competitors.length;
  const benchmarkId = randomUUID();
  const results: RunResult[] = [];

  emit({ type: "benchmark.started", benchmarkId, totalRuns });

  for (let sampleIndex = 0; sampleIndex < totalSamples; sampleIndex += 1) {
    const warmup = sampleIndex < preset.warmups;
    const sample = warmup ? sampleIndex + 1 : sampleIndex - preset.warmups + 1;
    for (const workload of workloads) {
      if (signal.aborted) throw signal.reason;
      try {
        const runResults =
          request.mode === "parallel"
            ? await runParallel(request.competitors, workload, sample, warmup, adapters, signal, emit)
            : await runSequential(request.competitors, workload, sample, warmup, adapters, signal, emit);
        if (signal.aborted) throw signal.reason;
        results.push(...runResults);
      } catch (error) {
        if (signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        for (const competitor of request.competitors) {
          emit({
            type: "run.error",
            competitorId: competitor.id,
            workload: workload.id as WorkloadId,
            sample,
            warmup,
            message,
          });
        }
      }
    }
  }

  if (signal.aborted) throw signal.reason;
  emit({
    type: "benchmark.complete",
    results,
    summary: summarizeResults(request.competitors, results),
  });
}
