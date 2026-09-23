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
import { settledWithin, untilAborted } from "./adapters/lib/run.js";
import type { AdapterRunOutput, HarnessAdapter } from "./adapters/types.js";
import { countNormalizedTokens, streamAnomalyMessage, summarizeResults } from "./metrics.js";
import { validateOutput, workloads } from "./workloads.js";

const presetRuns: Record<SamplePreset, { warmups: number; measured: number }> = {
  quick: { warmups: 0, measured: 1 },
  standard: { warmups: 1, measured: 3 },
  thorough: { warmups: 1, measured: 5 },
};

type Emit = (event: ServerEvent) => void;

const RUN_TIMEOUT_MS = 120_000;
// Long enough for every adapter to have sent SIGKILL to a child that ignored
// SIGTERM (Codex: up to 800 ms interrupt, then 1 s; Claude, which spawns the
// CLI itself rather than leaving the kill to the SDK's 2 s + 5 s close, and
// the ACP lanes: 1.5 s).
const TEARDOWN_GRACE_MS = 2_000;

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
  // One budget for setup and a fresh one for the run itself, so a slow lane's
  // prep does not eat a fast lane's run time. Neither covers the wait at the
  // parallel start barrier: see waitForStart.
  let timeout = setTimeout(
    () => controller.abort(new Error(`Harness was not ready to start within ${RUN_TIMEOUT_MS / 1000} seconds.`)),
    RUN_TIMEOUT_MS,
  );
  const abort = () => controller.abort(parentSignal.reason);
  parentSignal.addEventListener("abort", abort, { once: true });

  const workspace = await mkdtemp(join(tmpdir(), "harness-racer-"));
  const launchedAt = performance.now();
  let readyAt = launchedAt;
  let startedAt = launchedAt;
  let firstDeltaAt = 0;
  let lastDeltaAt = 0;
  let output = "";
  let deltaCount = 0;
  let readySignalled = false;
  let settled = false;
  // Adapters keep running for a while after the lane gave up on them (a
  // timed-out or cancelled child gets a grace period before SIGKILL), and
  // nothing they report then belongs to this lane, or to a benchmark started
  // since.
  const closed = () => settled || controller.signal.aborted;
  let adapterRun: Promise<AdapterRunOutput> | undefined;

  emit({ type: "run.status", competitorId: competitor.id, workload: workload.id, sample, warmup, status: "starting" });

  try {
    adapterRun = adapter.run({
      model: competitor.model,
      prompt: workload.prompt,
      cwd: workspace,
      signal: controller.signal,
      onReady: () => {
        // A second call from an adapter must not count twice toward the
        // parallel start barrier.
        if (readySignalled || closed()) return;
        readySignalled = true;
        readyAt = performance.now();
        emit({ type: "run.status", competitorId: competitor.id, workload: workload.id, sample, warmup, status: "ready" });
        input.onReady?.();
      },
      waitForStart: async () => {
        // The barrier opens when the last lane is ready or the first lane
        // ends, ready or not, and a lane stuck in setup fails on its own setup
        // timer, so a ready lane carries no timer of its own while it waits
        // here. Its failure would otherwise be reported as the harness not
        // being ready.
        clearTimeout(timeout);
        if (input.startGate) await untilAborted(input.startGate, controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason;
        startedAt = performance.now();
        timeout = setTimeout(
          () => controller.abort(new Error(`Run timed out after ${RUN_TIMEOUT_MS / 1000} seconds.`)),
          RUN_TIMEOUT_MS,
        );
        emit({ type: "run.status", competitorId: competitor.id, workload: workload.id, sample, warmup, status: "running" });
      },
      onDelta: (text) => {
        if (!text || closed()) return;
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
    const adapterResult = await untilAborted(adapterRun, controller.signal);

    // An adapter can resolve after its process was cut short by the abort, so
    // a resolved run is only complete if nothing aborted it in the meantime.
    if (controller.signal.aborted) throw controller.signal.reason;
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
  } catch (error) {
    // Adapters rethrow their own fixed "cancelled" error; the reason on the
    // signal (timeout or cancel message) is the one worth reporting.
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    settled = true;
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
    // A lane given up on (timeout or cancel) rejected before its adapter did,
    // and the adapter is still interrupting and killing its child. The next
    // lane or heat would otherwise be measured while sharing the machine with
    // that dying process, and the workspace it runs in would be deleted under
    // it. Wait for the adapter to settle, but not on one that never does.
    if (adapterRun) await settledWithin(adapterRun, TEARDOWN_GRACE_MS);
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
        // A cancelled lane is not a lane error; the benchmark as a whole is
        // cancelled once every lane has settled.
        if (!signal.aborted) {
          emit({
            type: "run.error",
            competitorId: competitor.id,
            workload: workload.id,
            sample,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      })
        // A lane that ends without ever being ready (failed during setup, or
        // an adapter that never said so) must not strand the rest behind the
        // barrier: they carry no timer of their own while they wait there.
        .finally(release);
    });

  const settled = await Promise.allSettled(tasks);
  if (signal.aborted) throw signal.reason;
  return settled.flatMap((outcome) => (outcome.status === "fulfilled" ? [outcome.value] : []));
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
        results.push(...runResults);
      } catch (error) {
        if (signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        for (const competitor of request.competitors) {
          emit({ type: "run.error", competitorId: competitor.id, workload: workload.id as WorkloadId, sample, message });
        }
      }
    }
  }

  emit({
    type: "benchmark.complete",
    results,
    summary: summarizeResults(request.competitors, results),
  });
}
