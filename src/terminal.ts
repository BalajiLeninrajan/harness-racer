import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import type {
  BenchmarkRequest,
  Competitor,
  ModelOption,
  ProviderInfo,
  RunMode,
  SamplePreset,
  ServerEvent,
  SummaryRow,
} from "./shared/types.js";
import { adapters as defaultAdapters } from "./server/adapters/index.js";
import type { HarnessAdapter } from "./server/adapters/types.js";
import { runBenchmark as defaultRunBenchmark } from "./server/benchmark.js";

const COLORS = ["#cba6f7", "#94e2d5", "#f9e2af", "#89b4fa", "#fab387", "#f5c2e7"];

export interface TerminalQuestioner {
  question(query: string, options?: { signal?: AbortSignal }): Promise<string>;
  close(): void;
  on?(event: "SIGINT", listener: () => void): unknown;
  removeListener?(event: "SIGINT", listener: () => void): unknown;
}

export interface TerminalWriter {
  write(text: string): unknown;
}

export type BenchmarkRunner = (
  request: BenchmarkRequest,
  adapterList: HarnessAdapter[],
  signal: AbortSignal,
  emit: (event: ServerEvent) => void,
) => Promise<void>;

export interface TerminalModeOptions {
  adapters?: readonly HarnessAdapter[];
  runBenchmark?: BenchmarkRunner;
  questioner?: TerminalQuestioner;
  input?: NodeJS.ReadableStream;
  output?: TerminalWriter;
  signal?: AbortSignal;
  handleSigint?: boolean;
  ui?: "auto" | "tui" | "line";
}

export type TerminalModeResult = "completed" | "cancelled" | "declined" | "failed" | "unavailable";

export interface ProbedAdapter {
  adapter: HarnessAdapter;
  provider?: ProviderInfo;
  error?: Error;
}

export interface RunnableAdapter {
  adapter: HarnessAdapter;
  provider: ProviderInfo;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function cancellationError(): Error {
  const error = new Error("Benchmark cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? cancellationError();
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? cancellationError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => finish(() => reject(signal.reason ?? cancellationError()));
    const finish = (settle: () => void) => {
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export function isRunnableProvider(provider: ProviderInfo): boolean {
  return provider.installed && provider.authenticated !== false && provider.models.length > 0;
}

export function defaultModelFor(provider: ProviderInfo): ModelOption {
  const configured = provider.defaultModel
    ? provider.models.find((model) => model.id === provider.defaultModel)
    : undefined;
  const model = configured ?? provider.models.find((candidate) => candidate.isDefault) ?? provider.models[0];
  if (!model) throw new Error(`${provider.name} has no models to run.`);
  return model;
}

export async function probeAdapters(adapterList: readonly HarnessAdapter[]): Promise<ProbedAdapter[]> {
  return Promise.all(adapterList.map(async (adapter) => {
    try {
      return { adapter, provider: await adapter.probe() };
    } catch (error) {
      return { adapter, error: asError(error) };
    }
  }));
}

function unavailableReason(item: ProbedAdapter): string {
  if (item.error) return item.error.message;
  const provider = item.provider;
  if (!provider) return "probe returned no provider information";
  if (provider.id !== item.adapter.id) return `reported an unexpected provider id (${provider.id})`;
  if (!provider.installed) return provider.message ?? "not installed";
  if (provider.authenticated === false) return provider.message ?? "not authenticated";
  if (provider.models.length === 0) return provider.message ?? "no models available";
  return provider.message ?? "unavailable";
}

async function askInteger(
  questioner: TerminalQuestioner,
  writer: TerminalWriter,
  prompt: string,
  minimum: number,
  maximum: number,
  defaultValue: number,
  signal: AbortSignal,
): Promise<number> {
  for (;;) {
    throwIfAborted(signal);
    const answer = (await questioner.question(prompt, { signal })).trim();
    throwIfAborted(signal);
    const value = answer === "" ? defaultValue : Number(answer);
    if (Number.isInteger(value) && value >= minimum && value <= maximum) return value;
    writer.write(`Please enter a number from ${minimum} to ${maximum}.\n`);
  }
}

async function askChoice(
  questioner: TerminalQuestioner,
  writer: TerminalWriter,
  prompt: string,
  choiceCount: number,
  defaultIndex: number,
  signal: AbortSignal,
): Promise<number> {
  return (await askInteger(questioner, writer, prompt, 1, choiceCount, defaultIndex + 1, signal)) - 1;
}

async function askConfirmation(
  questioner: TerminalQuestioner,
  writer: TerminalWriter,
  signal: AbortSignal,
): Promise<boolean> {
  for (;;) {
    throwIfAborted(signal);
    const answer = (await questioner.question("Start benchmark? [Y/n] ", { signal })).trim().toLowerCase();
    throwIfAborted(signal);
    if (answer === "" || answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    writer.write("Please answer yes or no.\n");
  }
}

function modelIndex(provider: ProviderInfo): number {
  const selected = defaultModelFor(provider);
  return Math.max(0, provider.models.findIndex((model) => model.id === selected.id));
}

export async function collectBenchmarkRequest(
  runnable: readonly RunnableAdapter[],
  questioner: TerminalQuestioner,
  writer: TerminalWriter,
  signal: AbortSignal,
): Promise<BenchmarkRequest | undefined> {
  if (runnable.length === 0) return undefined;

  const defaultCount = Math.min(3, Math.max(2, runnable.length));
  const count = await askInteger(
    questioner,
    writer,
    `How many racers? (2-6) [${defaultCount}] `,
    2,
    6,
    defaultCount,
    signal,
  );

  writer.write("\nHarnesses (a harness may be selected more than once):\n");
  runnable.forEach(({ provider }, index) => {
    writer.write(`  ${index + 1}. ${provider.name} (${provider.models.length} model${provider.models.length === 1 ? "" : "s"})\n`);
  });

  const competitors: Competitor[] = [];
  for (let index = 0; index < count; index += 1) {
    const defaultHarness = index % runnable.length;
    const harnessIndex = await askChoice(
      questioner,
      writer,
      `Racer ${index + 1} harness [${defaultHarness + 1}] `,
      runnable.length,
      defaultHarness,
      signal,
    );
    const provider = runnable[harnessIndex].provider;
    const preferredModel = modelIndex(provider);

    writer.write(`\n${provider.name} models:\n`);
    provider.models.forEach((model, optionIndex) => {
      const marker = optionIndex === preferredModel ? " (default)" : "";
      writer.write(`  ${optionIndex + 1}. ${model.label}${marker}\n`);
    });
    const selectedModelIndex = await askChoice(
      questioner,
      writer,
      `Racer ${index + 1} model [${preferredModel + 1}] `,
      provider.models.length,
      preferredModel,
      signal,
    );
    const model = provider.models[selectedModelIndex];
    competitors.push({
      id: `terminal-${index + 1}`,
      harness: provider.id,
      model: model.id,
      label: `${provider.name} / ${model.label}`,
      color: COLORS[index % COLORS.length],
    });
  }

  writer.write("\nRun mode:\n  1. Parallel (default)\n  2. Sequential\n");
  const modeIndex = await askChoice(questioner, writer, "Mode [1] ", 2, 0, signal);
  const mode: RunMode = modeIndex === 0 ? "parallel" : "sequential";

  writer.write("\nSample preset:\n  1. Quick\n  2. Standard (default)\n  3. Thorough\n");
  const presetIndex = await askChoice(questioner, writer, "Preset [2] ", 3, 1, signal);
  const presets: SamplePreset[] = ["quick", "standard", "thorough"];
  const samplePreset = presets[presetIndex];

  writer.write("\nReady to race:\n");
  competitors.forEach((competitor, index) => writer.write(`  ${index + 1}. ${competitor.label}\n`));
  writer.write(`  Mode: ${mode === "parallel" ? "Parallel" : "Sequential"}\n`);
  writer.write(`  Preset: ${samplePreset[0].toUpperCase()}${samplePreset.slice(1)}\n\n`);
  writer.write("This benchmark uses your normal model quota.\n");

  if (!(await askConfirmation(questioner, writer, signal))) return undefined;
  return { type: "start", competitors, mode, samplePreset };
}

export function formatMilliseconds(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value >= 1_000
    ? `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}s`
    : `${Math.round(value)}ms`;
}

export function formatTps(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(value >= 100 ? 0 : 1);
}

export function renderRankedSummary(summary: readonly SummaryRow[]): string {
  if (summary.length === 0) return "\nNo measured runs were completed.\n";
  const ranked = [...summary].sort((left, right) =>
    Number(left.disqualified) - Number(right.disqualified) || left.finishRank - right.finishRank
  );
  const lines = ranked.map((row) => {
    const place = row.disqualified ? "DSQ" : `#${row.finishRank}`;
    const anomaly = row.anomalousRuns > 0
      ? `, ${row.anomalousRuns} anomalous ${row.anomalousRuns === 1 ? "run" : "runs"}`
      : "";
    return `  ${place} ${row.competitor.label} — first output ${formatMilliseconds(row.promptToFirstOutputMs)}, cold start ${formatMilliseconds(row.coldStartToFirstOutputMs)}, ${formatTps(row.visibleTokensPerSecond)} visible tok/s, finish ${formatMilliseconds(row.promptToFinishMs)} (${row.validRuns}/${row.measuredRuns} valid${anomaly})`;
  });
  const eligibility = ranked.some((row) => !row.disqualified) ? "" : " — no eligible finishers";
  return `\nFinal classification${eligibility}\n${lines.join("\n")}\n`;
}

export function createTerminalEventRenderer(
  writer: TerminalWriter,
  competitors: readonly Competitor[],
): (event: ServerEvent) => void {
  const labels = new Map(competitors.map((competitor) => [competitor.id, competitor.label]));
  let totalRuns = 0;
  let completedRuns = 0;

  return (event) => {
    if (event.type === "run.delta" || event.type === "providers") return;

    if (event.type === "run.status") return;

    if (event.type === "benchmark.started") {
      totalRuns = event.totalRuns;
      completedRuns = 0;
      writer.write(`\nRace started (${totalRuns} runs). Press Ctrl-C to cancel.\n`);
      return;
    }

    if (event.type === "run.complete") {
      completedRuns += 1;
      const result = event.result;
      const label = labels.get(result.competitorId) ?? result.competitorId;
      const heat = result.warmup ? "warmup" : `sample ${result.sample}`;
      const validity = result.valid ? "" : ` — anomaly: ${result.validationMessage ?? "streaming measurement failed"}`;
      writer.write(
        `  [${completedRuns}/${totalRuns || "?"}] ${label} · ${result.workload} ${heat} — ${formatMilliseconds(result.metrics.promptToFirstOutputMs)} first output, ${formatTps(result.metrics.visibleTokensPerSecond)} visible tok/s${validity}\n`,
      );
      return;
    }

    if (event.type === "run.error") {
      completedRuns += 1;
      const label = labels.get(event.competitorId) ?? event.competitorId;
      const heat = event.warmup ? "warmup" : `sample ${event.sample}`;
      writer.write(`  [${completedRuns}/${totalRuns || "?"}] ${label} · ${event.workload} ${heat} — error: ${event.message}\n`);
      return;
    }

    if (event.type === "benchmark.complete") {
      writer.write(renderRankedSummary(event.summary));
      return;
    }

    if (event.type === "benchmark.cancelled") {
      writer.write("\nBenchmark cancelled.\n");
      return;
    }

    if (event.type === "error") writer.write(`\nError: ${event.message}\n`);
  };
}

export async function runTerminalMode(options: TerminalModeOptions = {}): Promise<TerminalModeResult> {
  const adapterList = [...(options.adapters ?? defaultAdapters)];
  const benchmark = options.runBenchmark ?? defaultRunBenchmark;
  const writer = options.output ?? stdout;
  const input = options.input ?? stdin;

  const usesInjectedRuntime = options.adapters !== undefined || options.runBenchmark !== undefined;
  if (!options.questioner && options.ui !== "line" && !usesInjectedRuntime) {
    const { runTerminalTui, supportsTerminalTui } = await import("./tui/index.js");
    const useTui = options.ui === "tui" || supportsTerminalTui(input, writer);
    if (useTui) {
      return runTerminalTui({
        input,
        output: writer,
        signal: options.signal,
        handleSigint: options.handleSigint,
      });
    }
  }

  if (options.ui === "tui" && usesInjectedRuntime) {
    throw new Error("The native TUI runs in a separate Bun process and cannot use injected adapters or benchmark runners. Use ui: \"line\" for programmatic runs.");
  }

  let questioner = options.questioner;
  let questionerClosed = false;
  const controller = new AbortController();
  const abortFromSignal = () => controller.abort(options.signal?.reason ?? cancellationError());
  const abortFromSigint = () => controller.abort(cancellationError());
  const attachQuestionerSignal = () => questioner?.on?.("SIGINT", abortFromSigint);
  const closeQuestioner = () => {
    if (!questioner || questionerClosed) return;
    questioner.removeListener?.("SIGINT", abortFromSigint);
    questioner.close();
    questionerClosed = true;
  };

  if (options.signal?.aborted) abortFromSignal();
  else options.signal?.addEventListener("abort", abortFromSignal, { once: true });
  if (options.handleSigint !== false) process.once("SIGINT", abortFromSigint);
  attachQuestionerSignal();

  try {
    writer.write("TPS Racer — terminal mode\n\nScanning local harnesses...\n");
    throwIfAborted(controller.signal);
    const probed = await raceWithSignal(probeAdapters(adapterList), controller.signal);
    const runnable: RunnableAdapter[] = [];
    for (const item of probed) {
      if (item.provider && item.provider.id === item.adapter.id && isRunnableProvider(item.provider)) {
        runnable.push({ adapter: item.adapter, provider: item.provider });
        writer.write(`  ✓ ${item.provider.name}: ${item.provider.models.length} model${item.provider.models.length === 1 ? "" : "s"}\n`);
      } else {
        writer.write(`  – ${item.provider?.name ?? item.adapter.name}: ${unavailableReason(item)}\n`);
      }
    }

    if (runnable.length === 0) {
      writer.write("\nNo runnable harnesses were found. Install and authenticate at least one supported CLI.\n");
      return "unavailable";
    }

    if (!questioner) {
      questioner = createInterface({
        input,
        output: writer as NodeJS.WritableStream,
      });
      attachQuestionerSignal();
    }
    const request = await collectBenchmarkRequest(runnable, questioner, writer, controller.signal);
    closeQuestioner();
    if (!request) {
      writer.write("\nBenchmark not started.\n");
      return "declined";
    }

    const selectedHarnesses = new Set(request.competitors.map((competitor) => competitor.harness));
    const selectedAdapters = runnable
      .filter(({ adapter }) => selectedHarnesses.has(adapter.id))
      .map(({ adapter }) => adapter);
    const render = createTerminalEventRenderer(writer, request.competitors);
    throwIfAborted(controller.signal);
    await raceWithSignal(benchmark(request, selectedAdapters, controller.signal, render), controller.signal);
    throwIfAborted(controller.signal);
    return "completed";
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      writer.write("\nBenchmark cancelled.\n");
      return "cancelled";
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abortFromSignal);
    if (options.handleSigint !== false) process.removeListener("SIGINT", abortFromSigint);
    closeQuestioner();
  }
}
