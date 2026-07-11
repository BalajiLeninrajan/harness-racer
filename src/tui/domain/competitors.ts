import type {
  BenchmarkRequest,
  Competitor,
  HarnessId,
  ModelOption,
  RunMode,
  SamplePreset,
} from "../../shared/types.js";
import type { ProbedAdapter, RunnableAdapter } from "../../terminal.js";
import { sanitizeTerminalText } from "../sanitize.js";

export { sanitizeTerminalText } from "../sanitize.js";

const COMPETITOR_COLORS = [
  "#cba6f7",
  "#94e2d5",
  "#f9e2af",
  "#89b4fa",
  "#fab387",
  "#f5c2e7",
] as const;

export interface ProbeCatalog {
  runnable: RunnableAdapter[];
  unavailable: ProbedAdapter[];
}

/** A stable provider/model option suitable for any interactive selection surface. */
export interface StackOption {
  value: string;
  label: string;
  harness: HarnessId;
  model: string;
}

export interface BenchmarkSettings {
  mode: RunMode;
  samplePreset: SamplePreset;
}

function isRunnableProbe(probe: ProbedAdapter): probe is RunnableAdapter {
  const provider = probe.provider;
  return Boolean(
    provider &&
    provider.id === probe.adapter.id &&
    provider.installed &&
    provider.authenticated !== false &&
    provider.models.length > 0,
  );
}

function defaultModel(provider: RunnableAdapter["provider"]): ModelOption {
  const configured = provider.defaultModel
    ? provider.models.find((model) => model.id === provider.defaultModel)
    : undefined;
  const model = configured ?? provider.models.find((candidate) => candidate.isDefault) ?? provider.models[0];
  if (!model) throw new Error(`${provider.name} has no models to run.`);
  return model;
}

function stackValue(harness: HarnessId, model: string): string {
  return `${harness}:${model}`;
}

export function categorizeProbes(probes: readonly ProbedAdapter[]): ProbeCatalog {
  const runnable: RunnableAdapter[] = [];
  const unavailable: ProbedAdapter[] = [];

  for (const probe of probes) {
    if (isRunnableProbe(probe)) runnable.push(probe);
    else unavailable.push(probe);
  }

  return { runnable, unavailable };
}

export function createStackOptions(runnable: readonly RunnableAdapter[]): StackOption[] {
  return runnable.flatMap(({ provider }) => {
    const providerLabel = sanitizeTerminalText(provider.name, "Unknown provider", 80);

    return provider.models.map((model) => ({
      value: stackValue(provider.id, model.id),
      label: `${providerLabel} / ${sanitizeTerminalText(model.label, "Unknown model", 120)}`,
      harness: provider.id,
      model: model.id,
    }));
  });
}

/** Pick the default model from up to three providers for a compact initial grid. */
export function defaultStackSelection(runnable: readonly RunnableAdapter[]): string[] {
  return runnable.slice(0, 3).map(({ provider }) =>
    stackValue(provider.id, defaultModel(provider).id)
  );
}

/**
 * Convert selected provider/model values into benchmark competitors.
 *
 * Multi-select values are unique, so selecting one stack means racing that stack
 * against a second instance of itself. Extra selections are capped at six lanes.
 */
export function createCompetitors(
  selectedValues: readonly string[],
  options: readonly StackOption[],
): Competitor[] {
  const optionByValue = new Map(options.map((option) => [option.value, option]));
  const stacks = selectedValues.slice(0, 6).map((value) => {
    const option = optionByValue.get(value);
    if (!option) throw new Error(`Unknown provider/model selection: ${value}`);
    return option;
  });

  if (stacks.length === 0) throw new Error("Select at least one provider/model stack.");
  if (stacks.length === 1) stacks.push(stacks[0]);

  return stacks.map((stack, index) => ({
    id: `terminal-${index + 1}`,
    harness: stack.harness,
    model: stack.model,
    label: stack.label,
    color: COMPETITOR_COLORS[index],
  }));
}

export function createBenchmarkRequest(
  competitors: readonly Competitor[],
  settings: Partial<BenchmarkSettings> = {},
): BenchmarkRequest {
  if (competitors.length < 2 || competitors.length > 6) {
    throw new RangeError("A benchmark needs between two and six competitors.");
  }

  return {
    type: "start",
    competitors: competitors.map((competitor) => ({ ...competitor })),
    mode: settings.mode ?? "parallel",
    samplePreset: settings.samplePreset ?? "standard",
  };
}
