import type {
  Competitor,
  ModelOption,
  ProviderInfo,
  RunMode,
  SamplePreset,
  ServerEvent,
  SummaryRow,
  WorkloadId,
} from "../shared/types.js";
import { MAX_RACERS, SAMPLE_PRESETS } from "./constants.js";
import { TUI_COLORS } from "./theme.js";

export { TUI_COLORS } from "./theme.js";

export interface RacerOption {
  key: string;
  provider: ProviderInfo;
  model: ModelOption;
}

export interface TuiLane {
  status: "queued" | "starting" | "ready" | "running" | "complete" | "error";
  workload?: WorkloadId;
  sample?: number;
  warmup?: boolean;
  output: string;
  harnessPrepMs?: number;
  firstOutputMs?: number;
  visibleTokensPerSecond?: number;
  completedRuns: number;
  error?: string;
}

export interface TuiRaceState {
  totalRuns: number;
  completedRuns: number;
  lanes: Record<string, TuiLane>;
  summary: SummaryRow[];
  error?: string;
}

export const emptyRaceState = (): TuiRaceState => ({
  totalRuns: 0,
  completedRuns: 0,
  lanes: {},
  summary: [],
});

export type ConfigureActivation =
  | { type: "start" }
  | { type: "mode"; value: RunMode }
  | { type: "preset"; value: SamplePreset };

export function configureActivation(cursor: number, trigger: "enter" | "space"): ConfigureActivation | undefined {
  if (trigger === "enter" || cursor === 5) return { type: "start" };
  if (cursor === 0) return { type: "mode", value: "parallel" };
  if (cursor === 1) return { type: "mode", value: "sequential" };
  if (cursor >= 2 && cursor <= 4) {
    return { type: "preset", value: SAMPLE_PRESETS[cursor - 2] };
  }
  return undefined;
}

export function racerOptions(providers: ProviderInfo[]): RacerOption[] {
  return providers
    .filter((provider) => provider.installed && provider.authenticated !== false)
    .flatMap((provider) =>
      provider.models
        .map((model, index) => ({ model, index }))
        .sort((a, b) => Number(Boolean(b.model.isDefault)) - Number(Boolean(a.model.isDefault)) || a.index - b.index)
        .map(({ model }) => ({
          key: `${provider.id}:${model.id}`,
          provider,
          model,
        })),
    );
}

export function defaultSelection(options: RacerOption[]): string[] {
  const selected: string[] = [];
  const usedProviders = new Set<string>();

  for (const option of options) {
    if (usedProviders.has(option.provider.id)) continue;
    selected.push(option.key);
    usedProviders.add(option.provider.id);
    if (selected.length === 3) break;
  }

  for (const option of options) {
    if (selected.length >= Math.min(3, options.length) || selected.includes(option.key)) continue;
    selected.push(option.key);
  }

  return selected;
}

export function competitorsFromSelection(options: RacerOption[], selection: readonly string[]): Competitor[] {
  const optionsByKey = new Map(options.map((option) => [option.key, option]));
  return selection
    .map((key) => optionsByKey.get(key))
    .filter((option): option is RacerOption => option !== undefined)
    .slice(0, MAX_RACERS)
    .map((option, index) => ({
      id: `tui-${index}-${option.provider.id}-${option.model.id}`,
      harness: option.provider.id,
      model: option.model.id,
      label: option.model.label,
      color: TUI_COLORS[index],
    }));
}

function choiceScore(option: RacerOption, rawQuery: string): number {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return option.model.isDefault ? 100 : 0;
  const haystack = [
    option.model.label,
    option.model.id,
    option.provider.name,
    option.provider.command,
  ].join(" ").toLowerCase();
  const tokens = query.split(/\s+/).filter(Boolean);
  if (!tokens.every((token) => haystack.includes(token))) return -1;
  if (option.model.label.toLowerCase() === query || option.model.id.toLowerCase() === query) return 1_000;
  if (option.model.label.toLowerCase().startsWith(query)) return 800;
  return 400;
}

export function filterRacerOptions(options: RacerOption[], providerId: string, query: string): RacerOption[] {
  return options
    .map((option, index) => ({ option, index, score: choiceScore(option, query) }))
    .filter((entry) => entry.option.provider.id === providerId && entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.option);
}

export function raceGridColumns(terminalColumns: number, racerCount: number): number {
  if (racerCount <= 1) return 1;
  const maxColumns = Math.min(racerCount, Math.max(1, Math.floor((terminalColumns + 1) / 39)));
  let bestColumns = 1;
  let bestRows = racerCount;
  for (let columns = 2; columns <= maxColumns; columns += 1) {
    const rows = Math.ceil(racerCount / columns);
    if (rows < bestRows) {
      bestColumns = columns;
      bestRows = rows;
    }
  }
  return bestColumns;
}

export function outputTail(output: string, width: number, maxLines: number): string {
  if (!output || maxLines <= 0) return "";
  const lineWidth = Math.max(1, width);
  const wrapped = output.replace(/\r\n?/g, "\n").split("\n").flatMap((line) => {
    if (!line) return [""];
    const chunks: string[] = [];
    for (let offset = 0; offset < line.length; offset += lineWidth) chunks.push(line.slice(offset, offset + lineWidth));
    return chunks;
  });
  return wrapped.slice(-maxLines).join("\n");
}

function lane(state: TuiRaceState, competitorId: string): TuiLane {
  return state.lanes[competitorId] ?? { status: "queued", output: "", completedRuns: 0 };
}

export function reduceRaceEvent(state: TuiRaceState, event: ServerEvent): TuiRaceState {
  if (event.type === "benchmark.started") return { ...state, totalRuns: event.totalRuns };

  if (event.type === "run.status") {
    const previous = lane(state, event.competitorId);
    const newRun = previous.workload !== event.workload || previous.sample !== event.sample || previous.warmup !== event.warmup;
    return {
      ...state,
      lanes: {
        ...state.lanes,
        [event.competitorId]: {
          ...previous,
          status: event.status,
          workload: event.workload,
          sample: event.sample,
          warmup: event.warmup,
          output: newRun ? "" : previous.output,
          harnessPrepMs: newRun ? undefined : previous.harnessPrepMs,
          firstOutputMs: newRun ? undefined : previous.firstOutputMs,
          visibleTokensPerSecond: newRun ? undefined : previous.visibleTokensPerSecond,
          error: event.status === "error" ? event.message : undefined,
        },
      },
    };
  }

  if (event.type === "run.delta") {
    const previous = lane(state, event.competitorId);
    return {
      ...state,
      lanes: {
        ...state.lanes,
        [event.competitorId]: {
          ...previous,
          status: "running",
          workload: event.workload,
          sample: event.sample,
          output: previous.output + event.text,
          firstOutputMs: previous.firstOutputMs ?? event.elapsedMs,
          visibleTokensPerSecond: event.liveVisibleTokensPerSecond ?? previous.visibleTokensPerSecond,
        },
      },
    };
  }

  if (event.type === "run.complete") {
    const previous = lane(state, event.result.competitorId);
    return {
      ...state,
      completedRuns: state.completedRuns + 1,
      lanes: {
        ...state.lanes,
        [event.result.competitorId]: {
          ...previous,
          status: "complete",
          output: event.result.output || previous.output,
          harnessPrepMs: event.result.metrics.harnessPrepMs,
          firstOutputMs: event.result.metrics.promptToFirstOutputMs,
          visibleTokensPerSecond: event.result.valid ? event.result.metrics.visibleTokensPerSecond : undefined,
          completedRuns: previous.completedRuns + 1,
          error: event.result.valid ? undefined : event.result.validationMessage,
        },
      },
    };
  }

  if (event.type === "run.error") {
    const previous = lane(state, event.competitorId);
    return {
      ...state,
      completedRuns: state.completedRuns + 1,
      lanes: {
        ...state.lanes,
        [event.competitorId]: {
          ...previous,
          status: "error",
          error: event.message,
          completedRuns: previous.completedRuns + 1,
        },
      },
    };
  }

  if (event.type === "benchmark.complete") {
    return {
      ...state,
      summary: [...event.summary].sort(
        (a, b) => Number(a.disqualified) - Number(b.disqualified) || a.finishRank - b.finishRank,
      ),
    };
  }

  if (event.type === "error") return { ...state, error: event.message };
  return state;
}
