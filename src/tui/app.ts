import { emitKeypressEvents } from "node:readline";

import type {
  BenchmarkRequest,
  Competitor,
  RunMode,
  RunResult,
  SamplePreset,
  ServerEvent,
  SummaryRow,
  WorkloadId,
} from "../shared/types.js";
import type { HarnessAdapter } from "../server/adapters/types.js";
import type {
  BenchmarkRunner,
  ProbedAdapter,
  RunnableAdapter,
  TerminalModeResult,
} from "../terminal.js";

const ENTER_SCREEN = "\u001b[?1049h\u001b[?25l\u001b[?7l";
const LEAVE_SCREEN = "\u001b[0m\u001b[?7h\u001b[?25h\u001b[?1049l";
const VIEWPORT_QUERY = "\u001b[18t\u001b7\u001b[9999C\u001b[6n\u001b8";
const VIEWPORT_PROBE_TIMEOUT_MS = 100;
const COLORS = ["#cba6f7", "#94e2d5", "#f9e2af", "#89b4fa", "#fab387", "#f5c2e7"];
const OUTPUT_TAIL_LIMIT = 12_000;

export interface TuiInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
}

export interface TuiOutput {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  getWindowSize?(): [number, number];
  write(text: string): unknown;
  on?(event: "resize", listener: () => void): unknown;
  removeListener?(event: "resize", listener: () => void): unknown;
}

export interface TerminalTuiOptions {
  adapters: readonly HarnessAdapter[];
  runBenchmark: BenchmarkRunner;
  probeAdapters: (adapters: readonly HarnessAdapter[]) => Promise<ProbedAdapter[]>;
  input: TuiInput;
  output: TuiOutput;
  signal?: AbortSignal;
  handleSigint?: boolean;
  color?: boolean;
  now?: () => number;
}

export interface TuiKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export type TuiView =
  | "scanning"
  | "setup"
  | "picker"
  | "running"
  | "cancelling"
  | "results"
  | "unavailable"
  | "error";

export interface TuiLane {
  competitorId: string;
  status: "queued" | "starting" | "ready" | "running" | "complete" | "invalid" | "error";
  workload?: WorkloadId;
  sample?: number;
  warmup?: boolean;
  output: string;
  liveTps?: number;
  ttftMs?: number;
  totalMs?: number;
  completedRuns: number;
  error?: string;
}

export interface TuiRunIssue {
  competitorId: string;
  workload: WorkloadId;
  sample: number;
  warmup: boolean;
  message: string;
}

export interface ModelPickerState {
  row: number;
  query: string;
  selected: number;
  chosenId: string;
}

export interface TuiState {
  view: TuiView;
  runnable: RunnableAdapter[];
  unavailable: ProbedAdapter[];
  competitors: Competitor[];
  selectedLane: number;
  mode: RunMode;
  preset: SamplePreset;
  picker?: ModelPickerState;
  totalRuns: number;
  completedRuns: number;
  completedRunKeys: string[];
  lanes: Record<string, TuiLane>;
  results: RunResult[];
  summary: SummaryRow[];
  issues: TuiRunIssue[];
  startedAt?: number;
  notice?: string;
  nextLaneId: number;
}

export type TuiEffect =
  | { type: "none" }
  | { type: "start" }
  | { type: "cancel" }
  | { type: "exit"; result: TerminalModeResult };

export interface RenderTuiOptions {
  columns: number;
  rows: number;
  color: boolean;
  now: number;
}

function defaultModel(provider: RunnableAdapter["provider"]): { id: string; label: string } {
  const configured = provider.defaultModel
    ? provider.models.find((model) => model.id === provider.defaultModel)
    : undefined;
  const model = configured ?? provider.models.find((candidate) => candidate.isDefault) ?? provider.models[0];
  if (!model) throw new Error(`${provider.name} has no models to run.`);
  return model;
}

function makeCompetitor(runnable: RunnableAdapter[], providerIndex: number, laneId: number): Competitor {
  const provider = runnable[providerIndex % runnable.length].provider;
  const model = defaultModel(provider);
  return {
    id: `terminal-${laneId}`,
    harness: provider.id,
    model: model.id,
    label: `${provider.name} / ${model.label}`,
    color: COLORS[(laneId - 1) % COLORS.length],
  };
}

export function initialTuiState(): TuiState {
  return {
    view: "scanning",
    runnable: [],
    unavailable: [],
    competitors: [],
    selectedLane: 0,
    mode: "parallel",
    preset: "standard",
    totalRuns: 0,
    completedRuns: 0,
    completedRunKeys: [],
    lanes: {},
    results: [],
    summary: [],
    issues: [],
    nextLaneId: 1,
  };
}

export function withProbeResults(state: TuiState, probed: ProbedAdapter[]): TuiState {
  const runnable = probed.flatMap((item): RunnableAdapter[] =>
    item.provider && item.provider.id === item.adapter.id && item.provider.installed &&
    item.provider.authenticated !== false && item.provider.models.length > 0
      ? [{ adapter: item.adapter, provider: item.provider }]
      : [],
  );
  if (!runnable.length) {
    return { ...state, view: "unavailable", runnable, unavailable: probed };
  }
  const count = Math.min(3, Math.max(2, runnable.length));
  const competitors = Array.from({ length: count }, (_, index) => makeCompetitor(runnable, index, index + 1));
  return {
    ...state,
    view: "setup",
    runnable,
    unavailable: probed.filter((item) => !runnable.some(({ adapter }) => adapter.id === item.adapter.id)),
    competitors,
    selectedLane: 0,
    nextLaneId: count + 1,
    lanes: Object.fromEntries(competitors.map((competitor) => [competitor.id, emptyLane(competitor.id)])),
  };
}

function emptyLane(competitorId: string): TuiLane {
  return { competitorId, status: "queued", output: "", completedRuns: 0 };
}

function wrap(index: number, size: number): number {
  return ((index % size) + size) % size;
}

function providerForCompetitor(state: TuiState, competitor: Competitor): RunnableAdapter | undefined {
  return state.runnable.find(({ provider }) => provider.id === competitor.harness);
}

function cycleHarness(state: TuiState, direction: number): TuiState {
  const competitor = state.competitors[state.selectedLane];
  if (!competitor || !state.runnable.length) return state;
  const current = state.runnable.findIndex(({ provider }) => provider.id === competitor.harness);
  const provider = state.runnable[wrap(current + direction, state.runnable.length)].provider;
  const model = defaultModel(provider);
  const competitors = state.competitors.map((item, index) => index === state.selectedLane ? {
    ...item,
    harness: provider.id,
    model: model.id,
    label: `${provider.name} / ${model.label}`,
  } : item);
  return { ...state, competitors };
}

function addLane(state: TuiState): TuiState {
  if (state.competitors.length >= 6 || !state.runnable.length) return state;
  const competitor = makeCompetitor(state.runnable, state.competitors.length, state.nextLaneId);
  return {
    ...state,
    competitors: [...state.competitors, competitor],
    selectedLane: state.competitors.length,
    nextLaneId: state.nextLaneId + 1,
    lanes: { ...state.lanes, [competitor.id]: emptyLane(competitor.id) },
  };
}

function removeLane(state: TuiState): TuiState {
  if (state.competitors.length <= 2) return state;
  const removed = state.competitors[state.selectedLane];
  const competitors = state.competitors.filter((_, index) => index !== state.selectedLane);
  const lanes = { ...state.lanes };
  if (removed) delete lanes[removed.id];
  return {
    ...state,
    competitors,
    lanes,
    selectedLane: Math.min(state.selectedLane, competitors.length - 1),
  };
}

function filteredModels(state: TuiState): Array<{ id: string; label: string }> {
  const picker = state.picker;
  const competitor = picker ? state.competitors[picker.row] : undefined;
  const provider = competitor ? providerForCompetitor(state, competitor)?.provider : undefined;
  if (!provider) return [];
  const query = picker?.query.trim().toLowerCase() ?? "";
  return provider.models.filter((model) =>
    !query || model.id.toLowerCase().includes(query) || model.label.toLowerCase().includes(query),
  );
}

function printableKey(key: TuiKey): string | undefined {
  if (key.ctrl || key.meta || !key.sequence || key.sequence.length !== 1) return undefined;
  return key.sequence >= " " && key.sequence !== "\u007f" ? key.sequence : undefined;
}

export function reduceTuiKey(state: TuiState, key: TuiKey): { state: TuiState; effect: TuiEffect } {
  const none = (next: TuiState = state) => ({ state: next, effect: { type: "none" } as TuiEffect });
  if (key.ctrl && key.name === "c") return { state: { ...state, view: "cancelling" }, effect: { type: "cancel" } };

  if (state.view === "scanning") {
    if (key.sequence === "q" || key.name === "escape") return { state, effect: { type: "exit", result: "declined" } };
    return none();
  }

  if (state.view === "unavailable") {
    if (key.sequence === "q" || key.name === "escape" || key.name === "return") {
      return { state, effect: { type: "exit", result: "unavailable" } };
    }
    return none();
  }

  if (state.view === "picker" && state.picker) {
    const models = filteredModels(state);
    if (key.name === "escape") return none({ ...state, view: "setup", picker: undefined });
    if (key.name === "up" || key.sequence === "k") {
      return none({ ...state, picker: { ...state.picker, selected: wrap(state.picker.selected - 1, Math.max(1, models.length)) } });
    }
    if (key.name === "down" || key.sequence === "j") {
      return none({ ...state, picker: { ...state.picker, selected: wrap(state.picker.selected + 1, Math.max(1, models.length)) } });
    }
    if (key.name === "backspace") {
      return none({ ...state, picker: { ...state.picker, query: state.picker.query.slice(0, -1), selected: 0 } });
    }
    if ((key.name === "space" || key.sequence === " ") && models.length) {
      const model = models[Math.min(state.picker.selected, models.length - 1)];
      const row = state.picker.row;
      const provider = providerForCompetitor(state, state.competitors[row])?.provider;
      const competitors = state.competitors.map((item, index) => index === row ? {
        ...item,
        model: model.id,
        label: `${provider?.name ?? item.harness} / ${model.label}`,
      } : item);
      return none({ ...state, competitors, picker: { ...state.picker, chosenId: model.id } });
    }
    if (key.name === "return") return none({ ...state, view: "setup", picker: undefined });
    const text = printableKey(key);
    if (text) return none({ ...state, picker: { ...state.picker, query: state.picker.query + text, selected: 0 } });
    return none();
  }

  if (state.view === "setup") {
    if (key.name === "up" || key.sequence === "k") return none({ ...state, selectedLane: wrap(state.selectedLane - 1, state.competitors.length) });
    if (key.name === "down" || key.sequence === "j") return none({ ...state, selectedLane: wrap(state.selectedLane + 1, state.competitors.length) });
    if (key.name === "left" || key.sequence === "h") return none(cycleHarness(state, -1));
    if (key.name === "right" || key.sequence === "l") return none(cycleHarness(state, 1));
    if (key.name === "space" || key.sequence === " ") {
      const competitor = state.competitors[state.selectedLane];
      const provider = competitor ? providerForCompetitor(state, competitor)?.provider : undefined;
      const selected = Math.max(0, provider?.models.findIndex((model) => model.id === competitor.model) ?? 0);
      return none({ ...state, view: "picker", picker: { row: state.selectedLane, query: "", selected, chosenId: competitor.model } });
    }
    if (key.sequence === "a" || key.sequence === "+") return none(addLane(state));
    if (key.sequence === "d" || key.name === "delete") return none(removeLane(state));
    if (key.sequence === "m") return none({ ...state, mode: state.mode === "parallel" ? "sequential" : "parallel" });
    if (key.sequence === "p") {
      const presets: SamplePreset[] = ["quick", "standard", "thorough"];
      return none({ ...state, preset: presets[(presets.indexOf(state.preset) + 1) % presets.length] });
    }
    if (key.name === "return") return { state, effect: { type: "start" } };
    if (key.sequence === "q" || key.name === "escape") return { state, effect: { type: "exit", result: "declined" } };
    return none();
  }

  if (state.view === "running") {
    if (key.sequence === "c" || key.sequence === "q" || key.name === "escape") {
      return { state: { ...state, view: "cancelling" }, effect: { type: "cancel" } };
    }
    return none();
  }

  if (state.view === "results") {
    if (key.name === "up" || key.sequence === "k") return none({ ...state, selectedLane: wrap(state.selectedLane - 1, Math.max(1, state.competitors.length)) });
    if (key.name === "down" || key.sequence === "j") return none({ ...state, selectedLane: wrap(state.selectedLane + 1, Math.max(1, state.competitors.length)) });
    if (key.sequence === "r") return { state, effect: { type: "start" } };
    if (key.sequence === "e") return none({ ...state, view: "setup" });
    if (key.sequence === "q" || key.name === "escape" || key.name === "return") {
      return { state, effect: { type: "exit", result: "completed" } };
    }
    return none();
  }

  if (state.view === "error") {
    if (key.sequence === "e" || key.name === "escape") return none({ ...state, view: "setup", notice: undefined });
    if (key.sequence === "q" || key.name === "return") return { state, effect: { type: "exit", result: "declined" } };
  }
  return none();
}

export function benchmarkRequestFromState(state: TuiState): BenchmarkRequest {
  return {
    type: "start",
    competitors: state.competitors.map((competitor) => ({ ...competitor })),
    mode: state.mode,
    samplePreset: state.preset,
  };
}

function safeText(value: string): string {
  return value
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))?/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r/g, "");
}

function safeMessage(value: string): string {
  const normalized = safeText(value).replace(/\s+/g, " ").trim();
  return normalized.slice(0, 2_000) || "Unknown error";
}

function completionKey(event: Extract<ServerEvent, { type: "run.complete" | "run.error" }>, warmup = false): string {
  if (event.type === "run.complete") {
    const result = event.result;
    return `${result.competitorId}\u0000${result.workload}\u0000${result.sample}\u0000${result.warmup}`;
  }
  return `${event.competitorId}\u0000${event.workload}\u0000${event.sample}\u0000${warmup}`;
}

export function reduceServerEvent(state: TuiState, event: ServerEvent, now = performance.now()): TuiState {
  if (event.type === "providers") return state;
  if (event.type === "benchmark.started") {
    return {
      ...state,
      view: "running",
      totalRuns: event.totalRuns,
      completedRuns: 0,
      completedRunKeys: [],
      startedAt: now,
      results: [],
      summary: [],
      issues: [],
      notice: undefined,
      lanes: Object.fromEntries(state.competitors.map((competitor) => [competitor.id, emptyLane(competitor.id)])),
    };
  }
  if (event.type === "run.status") {
    const prior = state.lanes[event.competitorId] ?? emptyLane(event.competitorId);
    const nextRun = prior.workload !== event.workload || prior.sample !== event.sample || prior.warmup !== event.warmup;
    return {
      ...state,
      lanes: {
        ...state.lanes,
        [event.competitorId]: {
          ...prior,
          status: event.status,
          workload: event.workload,
          sample: event.sample,
          warmup: event.warmup,
          output: nextRun ? "" : prior.output,
          liveTps: nextRun ? undefined : prior.liveTps,
          ttftMs: nextRun ? undefined : prior.ttftMs,
          totalMs: nextRun ? undefined : prior.totalMs,
          error: event.message ? safeMessage(event.message) : undefined,
        },
      },
    };
  }
  if (event.type === "run.delta") {
    const prior = state.lanes[event.competitorId] ?? emptyLane(event.competitorId);
    const output = `${prior.output}${safeText(event.text)}`.slice(-OUTPUT_TAIL_LIMIT);
    return {
      ...state,
      lanes: {
        ...state.lanes,
        [event.competitorId]: {
          ...prior,
          status: "running",
          workload: event.workload,
          sample: event.sample,
          output,
          liveTps: event.liveVisibleTokensPerSecond ?? prior.liveTps,
          ttftMs: prior.ttftMs ?? event.elapsedMs,
        },
      },
    };
  }
  if (event.type === "run.complete") {
    const result = event.result;
    const prior = state.lanes[result.competitorId] ?? emptyLane(result.competitorId);
    const key = completionKey(event);
    const first = !state.completedRunKeys.includes(key);
    return {
      ...state,
      completedRuns: state.completedRuns + (first ? 1 : 0),
      completedRunKeys: first ? [...state.completedRunKeys, key] : state.completedRunKeys,
      results: first ? [...state.results, result] : state.results,
      lanes: {
        ...state.lanes,
        [result.competitorId]: {
          ...prior,
          status: result.valid ? "complete" : "invalid",
          workload: result.workload,
          sample: result.sample,
          warmup: result.warmup,
          output: safeText(result.output || prior.output).slice(-OUTPUT_TAIL_LIMIT),
          liveTps: result.metrics.visibleTokensPerSecond,
          ttftMs: result.metrics.promptToFirstOutputMs,
          totalMs: result.metrics.promptToFinishMs,
          completedRuns: prior.completedRuns + (first ? 1 : 0),
          error: result.valid ? undefined : safeMessage(result.validationMessage ?? "invalid output"),
        },
      },
    };
  }
  if (event.type === "run.error") {
    const prior = state.lanes[event.competitorId] ?? emptyLane(event.competitorId);
    const key = completionKey(event, prior.warmup);
    const first = !state.completedRunKeys.includes(key);
    const message = safeMessage(event.message);
    return {
      ...state,
      completedRuns: state.completedRuns + (first ? 1 : 0),
      completedRunKeys: first ? [...state.completedRunKeys, key] : state.completedRunKeys,
      issues: first ? [...state.issues, {
        competitorId: event.competitorId,
        workload: event.workload,
        sample: event.sample,
        warmup: Boolean(prior.warmup),
        message,
      }] : state.issues,
      notice: message,
      lanes: {
        ...state.lanes,
        [event.competitorId]: {
          ...prior,
          status: "error",
          workload: event.workload,
          sample: event.sample,
          completedRuns: prior.completedRuns + (first ? 1 : 0),
          error: message,
        },
      },
    };
  }
  if (event.type === "benchmark.complete") {
    return {
      ...state,
      view: "results",
      results: event.results,
      summary: [...event.summary].sort((left, right) =>
        Number(left.disqualified) - Number(right.disqualified) || left.finishRank - right.finishRank
      ),
      selectedLane: 0,
    };
  }
  if (event.type === "benchmark.cancelled") return { ...state, view: "cancelling" };
  if (event.type === "error") return { ...state, view: "error", notice: safeMessage(event.message) };
  return state;
}

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function visibleWidth(value: string): number {
  return graphemes(stripAnsi(value)).reduce((total, grapheme) => total + graphemeWidth(grapheme), 0);
}

function graphemes(value: string): string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(value), (entry) => entry.segment);
}

function graphemeWidth(grapheme: string): number {
  const codePoints = [...grapheme].map((character) => character.codePointAt(0) ?? 0);
  if (
    grapheme.includes("\ufe0f") ||
    grapheme.includes("\u20e3") ||
    /\p{Extended_Pictographic}/u.test(grapheme) ||
    codePoints.some((codePoint) => codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff)
  ) return 2;
  return Math.max(0, ...[...grapheme].map(characterWidth));
}

function characterWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (codePoint === 0x200d || codePoint === 0xfe0e || codePoint === 0xfe0f || /\p{Mark}/u.test(character)) return 0;
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f ||
    codePoint === 0x2329 || codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3040 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) ? 2 : 1;
}

function takeCells(value: string, width: number): string {
  let result = "";
  let used = 0;
  for (const grapheme of graphemes(value)) {
    const next = graphemeWidth(grapheme);
    if (used + next > width) break;
    result += grapheme;
    used += next;
  }
  return result;
}

function clip(value: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(value) <= width) return value;
  if (width === 1) return "…";
  return `${takeCells(value, width - 1)}…`;
}

function pad(value: string, width: number, align: "left" | "right" = "left"): string {
  const clipped = clip(value, width);
  const remaining = Math.max(0, width - visibleWidth(clipped));
  return align === "right" ? `${" ".repeat(remaining)}${clipped}` : `${clipped}${" ".repeat(remaining)}`;
}

function style(value: string, code: string, color: boolean): string {
  return color ? `\u001b[${code}m${value}\u001b[0m` : value;
}

function bold(value: string, color: boolean): string {
  return style(value, "1", color);
}

function dim(value: string, color: boolean): string {
  return style(value, "2", color);
}

function accent(value: string, color: boolean): string {
  return style(value, "1;38;5;183", color);
}

function green(value: string, color: boolean): string {
  return style(value, "38;5;114", color);
}

function yellow(value: string, color: boolean): string {
  return style(value, "38;5;221", color);
}

function cyan(value: string, color: boolean): string {
  return style(value, "38;5;117", color);
}

function red(value: string, color: boolean): string {
  return style(value, "38;5;203", color);
}

function placeColor(value: string, rank: number | undefined, color: boolean): string {
  if (rank === 1) return style(value, "1;38;5;220", color);
  if (rank === 2) return style(value, "1;38;5;250", color);
  if (rank === 3) return style(value, "1;38;5;173", color);
  if (rank === undefined) return red(value, color);
  return dim(value, color);
}

function laneColor(value: string, hex: string, color: boolean, strong = false): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!color || !match) return strong ? bold(value, color) : value;
  const rgb = match.slice(1).map((part) => Number.parseInt(part, 16));
  return style(value, `${strong ? "1;" : ""}38;2;${rgb[0]};${rgb[1]};${rgb[2]}`, true);
}

function selectedRow(value: string, color: boolean): string {
  const content = value.startsWith("  ") ? value.slice(2) : value;
  const visible = content.trimEnd();
  const trailing = " ".repeat(Math.max(0, visibleWidth(content) - visibleWidth(visible)));
  return `${accent("›", color)} ${visible}${trailing}`;
}

function progressBar(done: number, total: number, width: number, color: boolean): string {
  const usable = Math.max(4, width);
  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  const filled = Math.round(usable * ratio);
  const complete = filled > 0 ? green("█".repeat(filled), color) : "";
  return `${complete}${dim("░".repeat(usable - filled), color)}`;
}

function formatMs(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}s` : `${Math.round(value)}ms`;
}

function formatTpsValue(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(value >= 100 ? 0 : 1);
}

function formatCount(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(Number.isInteger(value) ? 0 : 1);
}

function unavailableReason(item: ProbedAdapter): string {
  if (item.error) return safeMessage(item.error.message);
  const provider = item.provider;
  if (!provider) return "probe failed";
  if (!provider.installed) return safeMessage(provider.message ?? "not installed");
  if (provider.authenticated === false) return safeMessage(provider.message ?? "not authenticated");
  if (!provider.models.length) return safeMessage(provider.message ?? "no models");
  return safeMessage(provider.message ?? "unavailable");
}

function providerLine(state: TuiState, width: number, color: boolean): string {
  const entries = [
    ...state.runnable.map(({ provider }) => ({ text: `● ${provider.name}`, ready: true })),
    ...state.unavailable.map((item) => ({ text: `○ ${item.provider?.name ?? item.adapter.name}`, ready: false })),
  ];
  if (!entries.length) return dim(" checking local harnesses", color);
  let line = " ";
  for (const entry of entries) {
    const separator = visibleWidth(line) > 1 ? "   " : "";
    const available = width - visibleWidth(line) - visibleWidth(separator);
    if (available <= 0) break;
    const text = clip(entry.text, available);
    const styled = entry.ready && text.startsWith("●")
      ? `${green("●", color)}${text.slice(1)}`
      : dim(text, color);
    line += separator + styled;
    if (text !== entry.text) break;
  }
  return line;
}

function setupScreen(state: TuiState, options: RenderTuiOptions): string[] {
  const { columns, rows, color } = options;
  const harnessWidth = Math.min(14, Math.max(9, Math.floor(columns * 0.18)));
  const modelWidth = Math.max(14, columns - harnessWidth - 14);
  if (rows < state.competitors.length + 15) {
    const lines: string[] = [accent(" TPS RACER", color), bold(" STARTING GRID", color)];
    state.competitors.forEach((competitor, index) => {
      const provider = providerForCompetitor(state, competitor)?.provider;
      const model = provider?.models.find((candidate) => candidate.id === competitor.model);
      const plain = pad(`  ${String(index + 1).padStart(2, "0")}  ${pad(provider?.name ?? competitor.harness, harnessWidth)} ${pad(model?.label ?? competitor.model, modelWidth)}`, columns);
      lines.push(index === state.selectedLane ? selectedRow(plain, color) : plain);
    });
    lines.push("");
    lines.push(`  ${state.mode === "parallel" ? "● Same gun" : "● Time trial"}   ${state.preset[0].toUpperCase()}${state.preset.slice(1)}   ${state.competitors.length} racers`);
    lines.push(yellow("  Enter starts with normal model quota.", color));
    lines.push(dim(clip(" ↑↓ lane  ←→ harness  Space models  A/D lanes", columns), color));
    lines.push(dim(clip(" M/P settings  Enter start  Q quit", columns), color));
    return lines;
  }
  const lines: string[] = [accent(" TPS RACER", color), providerLine(state, columns, color), ""];
  lines.push(bold(" STARTING GRID", color));
  lines.push(dim(pad("    #  HARNESS         MODEL", columns), color));
  state.competitors.forEach((competitor, index) => {
    const provider = providerForCompetitor(state, competitor)?.provider;
    const model = provider?.models.find((candidate) => candidate.id === competitor.model);
    const plain = pad(
      `  ${String(index + 1).padStart(2, "0")}  ${pad(provider?.name ?? competitor.harness, harnessWidth)} ${pad(model?.label ?? competitor.model, modelWidth)}`,
      columns,
    );
    lines.push(index === state.selectedLane ? selectedRow(plain, color) : plain);
  });
  if (state.competitors.length < 6) lines.push(dim("      +  A  add another racer", color));
  lines.push("");
  lines.push(bold(" RACE SETUP", color));
  lines.push(`  Mode    ${state.mode === "parallel" ? "● Same gun" : "○ Same gun"}    ${state.mode === "sequential" ? "● Time trial" : "○ Time trial"}`);
  lines.push(`  Preset  ${state.preset === "quick" ? "●" : "○"} Quick    ${state.preset === "standard" ? "●" : "○"} Standard    ${state.preset === "thorough" ? "●" : "○"} Thorough`);
  lines.push(`  Tracks  Research prose + Python    Racers ${state.competitors.length}/6`);
  lines.push("");
  lines.push(yellow("  Enter starts the race using your normal model quota.", color));
  lines.push("");
  lines.push(dim(clip(" ↑↓ lane   ←→ harness   Space models   A/D lanes   M mode   P preset   Enter start   Q quit", columns), color));
  return lines;
}

function pickerScreen(state: TuiState, options: RenderTuiOptions): string[] {
  const { columns, rows, color } = options;
  const picker = state.picker;
  const competitor = picker ? state.competitors[picker.row] : undefined;
  const provider = competitor ? providerForCompetitor(state, competitor)?.provider : undefined;
  const models = filteredModels(state);
  const lines = [bold(` MODEL · LANE ${(picker?.row ?? 0) + 1} · ${provider?.name ?? "UNKNOWN"}`, color), ""];
  lines.push(` Filter: ${picker?.query ?? ""}`);
  lines.push("");
  if (!models.length) lines.push(red("  No models match that search.", color));
  const limit = Math.max(3, rows - 8);
  const selected = Math.min(picker?.selected ?? 0, Math.max(0, models.length - 1));
  const start = Math.max(0, Math.min(selected - Math.floor(limit / 2), models.length - limit));
  models.slice(start, start + limit).forEach((model, offset) => {
    const index = start + offset;
    const chosen = picker?.chosenId === model.id ? "●" : "○";
    const plain = pad(`  ${chosen}  ${clip(model.label, columns - 8)}`, columns);
    lines.push(index === selected ? selectedRow(plain, color) : plain);
  });
  lines.push("");
  lines.push(dim(clip(" ↑↓ move   Space select   Enter done   Esc back", columns), color));
  return lines;
}

function expectedRunsPerLane(preset: SamplePreset): number {
  return preset === "quick" ? 2 : preset === "standard" ? 8 : 12;
}

function laneHeat(lane: TuiLane): string {
  if (!lane.workload) return "queued";
  const heat = lane.warmup ? `W${lane.sample ?? 1}` : `S${lane.sample ?? 1}`;
  return `${lane.workload} ${heat}`;
}

function laneStatus(lane: TuiLane, now: number): string {
  if (lane.status === "running") return `${["◐", "◓", "◑", "◒"][Math.floor(now / 120) % 4]} STREAMING`;
  if (lane.status === "starting") return "◐ STARTING";
  if (lane.status === "ready") return "◐ READY";
  if (lane.status === "complete") return "✓ HEAT DONE";
  if (lane.status === "invalid") return "! ANOMALY";
  if (lane.status === "error") return "! ERROR";
  return "○ QUEUED";
}

function wrapText(value: string, width: number, maxLines: number): string[] {
  const sanitized = safeText(value).replace(/\t/g, "    ");
  if (!sanitized) return ["Waiting for visible output…"];
  const rows: string[] = [];
  for (const logicalLine of sanitized.split("\n")) {
    if (!logicalLine) {
      rows.push("");
      continue;
    }
    let remaining = logicalLine;
    while (remaining) {
      let part = takeCells(remaining, width);
      if (!part) break;
      if (part.length < remaining.length) {
        const breakAt = part.lastIndexOf(" ");
        if (breakAt > 0) part = part.slice(0, breakAt);
      }
      rows.push(part);
      remaining = remaining.slice(part.length).replace(/^ /, "");
    }
  }
  return rows.slice(-maxLines);
}

function runningScreen(state: TuiState, options: RenderTuiOptions): string[] {
  const { columns, rows, color, now } = options;
  const elapsed = state.startedAt === undefined ? 0 : Math.max(0, now - state.startedAt);
  const percentage = state.totalRuns ? Math.round((state.completedRuns / state.totalRuns) * 100) : 0;
  const barWidth = Math.max(8, columns - 40);
  const lines: string[] = [];
  lines.push(bold(` LIVE · ${state.mode === "parallel" ? "SAME GUN" : "TIME TRIAL"} · ${state.preset.toUpperCase()}`, color));
  lines.push(` ${String(state.completedRuns).padStart(2)}/${String(state.totalRuns || "—").padEnd(2)}  ${progressBar(state.completedRuns, state.totalRuns, barWidth, color)}  ${String(percentage).padStart(3)}%  ${formatMs(elapsed)}`);
  lines.push("");

  const count = state.competitors.length;
  const preferredColumns = columns >= 116
    ? (count <= 2 ? count : count === 4 ? 2 : 3)
    : columns >= 50 ? (count === 1 ? 1 : 2) : 1;
  const gap = 1;
  const minimumPaneWidth = 22;
  const minimumPaneHeight = 6;
  const footerRows = state.notice ? 2 : 1;
  const maxColumnsByWidth = Math.max(1, Math.min(count, Math.floor((columns + gap) / (minimumPaneWidth + gap))));
  const maxRowsByHeight = Math.max(1, Math.floor((rows - lines.length - footerRows + gap) / (minimumPaneHeight + gap)));
  const columnsNeededForHeight = Math.ceil(count / maxRowsByHeight);
  const gridColumns = Math.min(maxColumnsByWidth, Math.max(preferredColumns, columnsNeededForHeight));
  const gridRows = Math.ceil(count / gridColumns);
  const requiredRows = lines.length + gridRows * minimumPaneHeight + (gridRows - 1) * gap + footerRows;
  if (gridColumns < columnsNeededForHeight || requiredRows > rows) {
    return [
      lines[0],
      "",
      yellow(` Resize to at least ${requiredRows} rows to show all ${count} live outputs.`, color),
      " No racer will be hidden or collapsed.",
      "",
      dim(" Q cancel   Ctrl-C stop now", color),
    ];
  }
  const paneSpace = columns - gap * (gridColumns - 1);
  const basePaneWidth = Math.floor(paneSpace / gridColumns);
  const extraPaneCells = paneSpace % gridColumns;
  const paneWidths = Array.from({ length: gridColumns }, (_, index) => basePaneWidth + (index < extraPaneCells ? 1 : 0));
  const availableHeight = rows - lines.length - footerRows;
  const paneHeight = Math.floor((availableHeight - gap * (gridRows - 1)) / gridRows);
  const expected = expectedRunsPerLane(state.preset);

  const pane = (competitor: Competitor, index: number, paneWidth: number): string[] => {
    const lane = state.lanes[competitor.id] ?? emptyLane(competitor.id);
    const inside = paneWidth - 2;
    const bodyHeight = Math.max(1, paneHeight - 5);
    const status = laneStatus(lane, now);
    const identity = `${String(index + 1).padStart(2, "0")} ${competitor.label}`;
    const timing = `${laneHeat(lane)} · ${status}`;
    const metrics = `FIRST ${formatMs(lane.ttftMs)} · TOK/S ${formatTpsValue(lane.liveTps)} · ${lane.completedRuns}/${expected}`;
    const output = wrapText(lane.output, Math.max(8, inside - 2), bodyHeight);
    while (output.length < bodyHeight) output.unshift("");
    const failed = lane.status === "error";
    const anomalous = lane.status === "invalid";
    const border = (value: string) => failed ? red(value, color) : anomalous ? yellow(value, color) : laneColor(value, competitor.color, color);
    const bordered = (content: string) => `${border("│")}${content}${border("│")}`;
    const statusContent = failed
      ? red(pad(` ${timing}`, inside), color)
      : anomalous
        ? yellow(pad(` ${timing}`, inside), color)
      : lane.status === "running" || lane.status === "ready" || lane.status === "complete"
        ? green(pad(` ${timing}`, inside), color)
        : lane.status === "starting"
          ? yellow(pad(` ${timing}`, inside), color)
          : dim(pad(` ${timing}`, inside), color);
    const exact = [
      border(`┌${"─".repeat(inside)}┐`),
      bordered(laneColor(pad(` ${identity}`, inside), competitor.color, color, true)),
      bordered(statusContent),
      bordered(cyan(pad(` ${metrics}`, inside), color)),
      ...output.map((line) => bordered(lane.output ? pad(` ${line}`, inside) : dim(pad(` ${line}`, inside), color))),
      border(`└${"─".repeat(inside)}┘`),
    ].slice(0, paneHeight);
    exact[exact.length - 1] = border(`└${"─".repeat(inside)}┘`);
    return exact;
  };

  for (let row = 0; row < gridRows; row += 1) {
    const panes = Array.from({ length: gridColumns }, (_, column) => {
      const index = row * gridColumns + column;
      const paneWidth = paneWidths[column];
      return index < count ? pane(state.competitors[index], index, paneWidth) : Array.from({ length: paneHeight }, () => " ".repeat(paneWidth));
    });
    for (let lineIndex = 0; lineIndex < paneHeight; lineIndex += 1) {
      lines.push(panes.map((item) => item[lineIndex]).join(" "));
    }
    if (row < gridRows - 1) lines.push("");
  }
  if (state.notice) lines.push(red(` ! ${clip(state.notice, columns - 4)}`, color));
  lines.push(dim(clip(" Q cancel   Ctrl-C stop now", columns), color));
  return lines;
}

interface WorkloadDetail {
  valid: number;
  recorded: number;
  totalMs: number;
  minTotalMs: number;
  maxTotalMs: number;
  ttftMs: number;
  normalizedTps: number;
  setupMs: number;
  streamMs: number;
  deltas: number;
}

interface ClassificationEntry {
  competitor: Competitor;
  summary?: SummaryRow;
}

function classificationEntries(state: TuiState): ClassificationEntry[] {
  const ranked = new Set(state.summary.map((row) => row.competitor.id));
  return [
    ...state.summary.map((summary) => ({ competitor: summary.competitor, summary })),
    ...state.competitors
      .filter((competitor) => !ranked.has(competitor.id))
      .map((competitor) => ({ competitor })),
  ];
}

function medianValue(values: number[]): number {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!finite.length) return Number.POSITIVE_INFINITY;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

function workloadDetail(
  results: RunResult[],
  workload: WorkloadId,
  includeAnomalous = false,
): WorkloadDetail {
  const recorded = results.filter((result) => !result.warmup && result.workload === workload);
  const valid = recorded.filter((result) => result.valid);
  const summarized = includeAnomalous && valid.length === 0 ? recorded : valid;
  const totals = summarized.map((result) => result.metrics.promptToFinishMs).filter(Number.isFinite);
  return {
    valid: valid.length,
    recorded: recorded.length,
    totalMs: medianValue(totals),
    minTotalMs: totals.length ? Math.min(...totals) : Number.POSITIVE_INFINITY,
    maxTotalMs: totals.length ? Math.max(...totals) : Number.POSITIVE_INFINITY,
    ttftMs: medianValue(summarized.map((result) => result.metrics.promptToFirstOutputMs)),
    normalizedTps: medianValue(summarized.map((result) => result.metrics.visibleTokensPerSecond)),
    setupMs: medianValue(summarized.map((result) => result.metrics.harnessPrepMs)),
    streamMs: medianValue(summarized.map((result) => result.metrics.visibleStreamMs)),
    deltas: medianValue(summarized.map((result) => result.metrics.streamChunkCount)),
  };
}

function expectedMeasuredPerWorkload(preset: SamplePreset): number {
  return preset === "quick" ? 1 : preset === "standard" ? 3 : 5;
}

function formatRange(detail: WorkloadDetail): string {
  if (!Number.isFinite(detail.totalMs)) return "—";
  return `${formatMs(detail.totalMs)} (${formatMs(detail.minTotalMs)}–${formatMs(detail.maxTotalMs)})`;
}

type DetailTone = "plain" | "dim" | "accent" | "yellow" | "red";

interface DetailCardRow {
  text: string;
  tone?: DetailTone;
}

function detailTone(value: string, tone: DetailTone | undefined, color: boolean): string {
  if (tone === "dim") return dim(value, color);
  if (tone === "accent") return accent(value, color);
  if (tone === "yellow") return yellow(value, color);
  if (tone === "red") return red(value, color);
  return value;
}

function detailCard(
  title: string,
  body: DetailCardRow[],
  width: number,
  laneHex: string,
  color: boolean,
): string[] {
  const cardWidth = Math.max(8, width);
  const label = clip(` ${title} `, Math.max(1, cardWidth - 4));
  const topFill = "─".repeat(Math.max(1, cardWidth - 3 - visibleWidth(label)));
  const border = (value: string, strong = false) => laneColor(value, laneHex, color, strong);
  const inside = cardWidth - 2;
  const bodyLines = body.map((row) => {
    const text = clip(row.text, Math.max(1, inside - 2));
    const content = pad(` ${text}`, inside);
    return `${border("│")}${detailTone(content, row.tone, color)}${border("│")}`;
  });
  return [
    border(`┌─${label}${topFill}┐`, true),
    ...bodyLines,
    border(`└${"─".repeat(inside)}┘`),
  ];
}

function resultsScreen(state: TuiState, options: RenderTuiOptions): string[] {
  const { columns, rows, color } = options;
  const lines: string[] = [];
  const expectedPerWorkload = expectedMeasuredPerWorkload(state.preset);
  const expectedPerRacer = expectedPerWorkload * 2;
  const expectedTotal = expectedPerRacer * state.competitors.length;
  const validTotal = state.summary.reduce((total, row) => total + row.validRuns, 0);
  const eligible = state.summary.filter((row) => !row.disqualified);
  const winner = eligible[0];
  const runnerUp = eligible[1];
  const validity = `${validTotal}/${expectedTotal} VALID`;
  const styledValidity = validTotal === expectedTotal
    ? green(validity, color)
    : validTotal > 0 ? yellow(validity, color) : red(validity, color);
  lines.push(`${accent(` RESULTS · ${state.preset.toUpperCase()} · ${state.mode === "parallel" ? "SAME GUN" : "TIME TRIAL"} ·`, color)} ${styledValidity}`);
  if (winner && rows >= 18) {
    const margin = runnerUp ? ` · WON BY ${formatMs(Math.max(0, runnerUp.promptToFinishMs - winner.promptToFinishMs))}` : " · SOLO FINISHER";
    lines.push(green(` WINNER · ${clip(winner.competitor.label, Math.max(12, columns - margin.length - 24))} · ${formatMs(winner.promptToFinishMs)}${margin}`, color));
  } else if (!winner && rows >= 18) lines.push(red(" NO ELIGIBLE FINISHERS", color));
  const classificationStart = lines.length;

  const compact = columns < 76;
  const wide = columns >= 100;
  const rankWidth = 3;
  const metricWidth = compact ? 7 : 9;
  const runsWidth = 5;
  const gapWidth = wide ? 9 : 0;
  const racerWidth = Math.max(12, columns - rankWidth - runsWidth - gapWidth - metricWidth * (compact ? 2 : wide ? 4 : 3) - 10);
  const classification = classificationEntries(state);
  lines.push(dim(wide
    ? ` PL ${pad("RACER", racerWidth)} ${pad("FINISH", metricWidth, "right")} ${pad("GAP", gapWidth, "right")} ${pad("FIRST", metricWidth, "right")} ${pad("COLD", metricWidth, "right")} ${pad("TOK/S", metricWidth, "right")} ${pad("VALID", runsWidth, "right")}`
    : compact
      ? ` PL ${pad("RACER", racerWidth)} ${pad("FINISH", metricWidth, "right")} ${pad("TOK/S", metricWidth, "right")} ${pad("OK", runsWidth, "right")}`
      : ` PL ${pad("RACER", racerWidth)} ${pad("FINISH", metricWidth, "right")} ${pad("FIRST", metricWidth, "right")} ${pad("TOK/S", metricWidth, "right")} ${pad("VALID", runsWidth, "right")}`,
  color));
  classification.forEach((entry, index) => {
    const row = entry.summary;
    const crown = (metric: SummaryRow["crowns"][number], value: string) => row?.crowns.includes(metric) ? `★${value}` : value;
    const rank = row ? row.disqualified ? "DSQ" : `P${row.finishRank}` : "DNF";
    const place = placeColor(pad(rank, rankWidth, "right"), row?.disqualified ? undefined : row?.finishRank, color);
    const gap = winner && row && !row.disqualified && row.finishRank > 1 ? `+${formatMs(Math.max(0, row.promptToFinishMs - winner.promptToFinishMs))}` : "—";
    const total = crown("finish", formatMs(row?.promptToFinishMs));
    const ttft = crown("firstOutput", formatMs(row?.promptToFirstOutputMs));
    const cold = crown("coldStart", formatMs(row?.coldStartToFirstOutputMs));
    const tps = crown("visibleSpeed", formatTpsValue(row?.visibleTokensPerSecond));
    const validDenominator = row?.measuredRuns ?? expectedPerRacer;
    const valid = `${row?.validRuns ?? 0}/${validDenominator}${row?.anomalousRuns ? "!" : ""}`;
    const validCell = row?.anomalousRuns
      ? yellow(pad(valid, runsWidth, "right"), color)
      : pad(valid, runsWidth, "right");
    const plain = wide
      ? `  ${place} ${pad(entry.competitor.label, racerWidth)} ${pad(total, metricWidth, "right")} ${pad(gap, gapWidth, "right")} ${pad(ttft, metricWidth, "right")} ${pad(cold, metricWidth, "right")} ${pad(tps, metricWidth, "right")} ${validCell}`
      : compact
        ? `  ${place} ${pad(entry.competitor.label, racerWidth)} ${pad(total, metricWidth, "right")} ${pad(tps, metricWidth, "right")} ${validCell}`
        : `  ${place} ${pad(entry.competitor.label, racerWidth)} ${pad(total, metricWidth, "right")} ${pad(ttft, metricWidth, "right")} ${pad(tps, metricWidth, "right")} ${validCell}`;
    lines.push(index === state.selectedLane ? selectedRow(pad(plain, columns), color) : pad(plain, columns));
  });

  const selectedEntry = classification[Math.min(state.selectedLane, Math.max(0, classification.length - 1))];
  let renderedCard: string[] = [];
  if (selectedEntry) {
    const selected = selectedEntry.summary;
    const measured = state.results.filter((result) => result.competitorId === selectedEntry.competitor.id && !result.warmup);
    const prose = workloadDetail(measured, "prose", Boolean(selected?.disqualified));
    const code = workloadDetail(measured, "code", Boolean(selected?.disqualified));
    const gap = selected && !selected.disqualified && winner ? Math.max(0, selected.promptToFinishMs - winner.promptToFinishMs) : 0;
    const gapPercent = selected && !selected.disqualified && winner && winner.promptToFinishMs > 0 ? (gap / winner.promptToFinishMs) * 100 : 0;
    const missing = Math.max(0, expectedPerRacer - measured.length);
    const invalid = measured.filter((result) => !result.valid);
    const issues = state.issues.filter((issue) => issue.competitorId === selectedEntry.competitor.id);
    const crownLabel = selected?.crowns.map((crown) => ({
      finish: "FINISH",
      firstOutput: "FIRST",
      coldStart: "COLD",
      visibleSpeed: "TOK/S",
    })[crown]).join(" · ") ?? "";
    const diagnosticRows: DetailCardRow[] = [];
    if (invalid.length) diagnosticRows.push({
      tone: selected?.disqualified ? "red" : "yellow",
      text: `ANOMALY · ${invalid[0].workload} S${invalid[0].sample} · ${safeMessage(invalid[0].validationMessage ?? "invalid output")}${invalid.length > 1 ? ` · +${invalid.length - 1} more` : ""}`,
    });
    if (issues.length) {
      const issue = issues[0];
      diagnosticRows.push({
        tone: "red",
        text: `ERROR · ${issue.workload} ${issue.warmup ? "W" : "S"}${issue.sample} · ${issue.message}${issues.length > 1 ? ` · +${issues.length - 1} more` : ""}`,
      });
    }
    if (missing) diagnosticRows.push({
      tone: "yellow",
      text: `NO RESULT · ${missing} measured ${missing === 1 ? "run" : "runs"}`,
    });

    const availableCardRows = Math.max(0, rows - lines.length - 1);
    if (availableCardRows >= 3) {
      const bodyBudget = availableCardRows - 2;
      const title = selected?.disqualified
        ? `DETAILS · DSQ ${selectedEntry.competitor.label} · ALL ${selected.anomalousRuns} ${selected.anomalousRuns === 1 ? "RUN" : "RUNS"} ANOMALOUS`
        : selected
          ? `DETAILS · P${selected.finishRank} ${selectedEntry.competitor.label} · ${selected.finishRank > 1 ? `+${formatMs(gap)} (${gapPercent.toFixed(1)}%) TO P1` : "LEADER"}`
          : `DETAILS · DNF ${selectedEntry.competitor.label} · NO RESULTS`;
      let body: DetailCardRow[];
      if (!selected) {
        body = diagnosticRows;
      } else {
        const detailed: DetailCardRow[] = [];
        if (wide) {
          detailed.push({
            tone: "dim",
            text: `${pad("WORKLOAD", 9)} ${pad("OK", 5)} ${pad("FINISH MED (MIN–MAX)", 22)} ${pad("FIRST", 8, "right")} ${pad("TOK/S", 7, "right")} ${pad("PREP", 8, "right")} ${pad("STREAM", 8, "right")} ${pad("CHUNKS", 7, "right")}`,
          });
          for (const [name, stats] of [["prose", prose], ["code", code]] as const) {
            detailed.push({
              text: `${pad(name, 9)} ${pad(`${stats.valid}/${stats.recorded}`, 5)} ${pad(formatRange(stats), 22)} ${pad(formatMs(stats.ttftMs), 8, "right")} ${pad(formatTpsValue(stats.normalizedTps), 7, "right")} ${pad(formatMs(stats.setupMs), 8, "right")} ${pad(formatMs(stats.streamMs), 8, "right")} ${pad(formatCount(stats.deltas), 7, "right")}`,
            });
          }
        } else {
          for (const [name, stats] of [["PROSE", prose], ["CODE", code]] as const) {
            detailed.push({ text: `${name} ${stats.valid}/${stats.recorded} · FINISH ${formatRange(stats)}` });
            detailed.push({ text: `  FIRST ${formatMs(stats.ttftMs)} · TOK/S ${formatTpsValue(stats.normalizedTps)} · PREP ${formatMs(stats.setupMs)}${compact ? "" : ` · STREAM ${formatMs(stats.streamMs)} · CHUNKS ${formatCount(stats.deltas)}`}` });
            if (compact) detailed.push({ text: `  STREAM ${formatMs(stats.streamMs)} · CHUNKS ${formatCount(stats.deltas)}` });
          }
        }
        if (selected.disqualified) detailed.push({
          tone: "red",
          text: "RECORDED · NOT RANKED · metrics include anomalous output",
        });
        const best = crownLabel ? [{ tone: "yellow" as const, text: `BEST · ${crownLabel}` }] : [];
        const dense = [...detailed, ...best, ...diagnosticRows];
        const spaced: DetailCardRow[] = [];
        const appendSection = (section: DetailCardRow[]) => {
          if (!section.length) return;
          if (spaced.length) spaced.push({ text: "" });
          spaced.push(...section);
        };
        if (wide) {
          appendSection(detailed);
        } else {
          const workloadRows = compact ? 3 : 2;
          appendSection(detailed.slice(0, workloadRows));
          appendSection(detailed.slice(workloadRows));
        }
        appendSection(best);
        appendSection(diagnosticRows);
        if (spaced.length <= bodyBudget) {
          body = spaced;
        } else if (dense.length <= bodyBudget) {
          body = dense;
        } else {
          const condensed: DetailCardRow[] = [
            { text: `PROSE ${prose.valid}/${prose.recorded} · ${formatMs(prose.totalMs)} · FIRST ${formatMs(prose.ttftMs)} · TOK/S ${formatTpsValue(prose.normalizedTps)}` },
            { text: `CODE ${code.valid}/${code.recorded} · ${formatMs(code.totalMs)} · FIRST ${formatMs(code.ttftMs)} · TOK/S ${formatTpsValue(code.normalizedTps)}` },
          ];
          const auxiliary: DetailCardRow[] = [
            { text: `PROSE · PREP ${formatMs(prose.setupMs)} · STREAM ${formatMs(prose.streamMs)} · CHUNKS ${formatCount(prose.deltas)}` },
            { text: `CODE · PREP ${formatMs(code.setupMs)} · STREAM ${formatMs(code.streamMs)} · CHUNKS ${formatCount(code.deltas)}` },
          ];
          const primarySlots = Math.max(0, bodyBudget - diagnosticRows.length);
          let primary: DetailCardRow[];
          if (primarySlots === 1) {
            primary = [{ text: `PROSE ${formatMs(prose.totalMs)} · CODE ${formatMs(code.totalMs)} · ${selected.validRuns}/${selected.measuredRuns} VALID` }];
          } else if (primarySlots <= 2) {
            primary = condensed.slice(0, primarySlots);
          } else if (primarySlots === 3) {
            primary = [...condensed, ...best.slice(0, 1)];
          } else {
            const ranges: DetailCardRow[] = [{
              text: `RANGE · P ${formatMs(prose.minTotalMs)}–${formatMs(prose.maxTotalMs)} · C ${formatMs(code.minTotalMs)}–${formatMs(code.maxTotalMs)}`,
            }];
            primary = [...condensed, ...auxiliary, ...ranges, ...best].slice(0, primarySlots);
          }
          body = [...primary, ...diagnosticRows].slice(-bodyBudget);
        }
      }
      if (!body.length) body = [{ tone: "dim", text: "No measured details available." }];
      renderedCard = detailCard(title, body.slice(0, bodyBudget), Math.min(columns, 120), selectedEntry.competitor.color, color);
    }
  }
  if (renderedCard.length) {
    const spareRows = Math.max(0, rows - lines.length - renderedCard.length - 1);
    if (spareRows >= 2) lines.splice(classificationStart, 0, "");
    if (spareRows >= 1) lines.push("");
    lines.push(...renderedCard);
    if (spareRows >= 3) lines.push("");
  }
  const footer = dim(clip(columns < 70
    ? " ↑↓ details   R rerun   E edit   Q quit"
    : " ↑↓ racer details   R race again   E edit grid   Enter/Q quit", columns), color);
  if (lines.length >= rows) lines[rows - 1] = footer;
  else lines.push(footer);
  return lines.slice(0, rows);
}

export function renderTuiFrame(state: TuiState, options: RenderTuiOptions): string {
  const columns = Math.max(1, Math.floor(options.columns));
  const rows = Math.max(1, Math.floor(options.rows));
  if (columns < 48 || rows < 14) {
    const message = [
      accent(clip(" TPS RACER", columns), options.color),
      "",
      clip(" Resize the terminal to at least 48×14.", columns),
      clip(" Ctrl-C or Q to quit.", columns),
    ];
    return message.slice(0, rows).join("\n");
  }
  let lines: string[];
  if (state.view === "scanning") {
    const spinner = ["◐", "◓", "◑", "◒"][Math.floor(options.now / 120) % 4];
    lines = [accent(" TPS RACER", options.color), "", accent(` ${spinner} SCANNING LOCAL HARNESSES`, options.color), "", dim(" Checking installs, authentication, and model inventories…", options.color), "", dim(" Q quit", options.color)];
  } else if (state.view === "unavailable") {
    lines = [accent(" TPS RACER", options.color), "", red(" NO RUNNABLE HARNESSES", options.color), ""];
    for (const item of state.unavailable) lines.push(`  ○ ${item.provider?.name ?? item.adapter.name} · ${clip(unavailableReason(item), columns - 8)}`);
    lines.push("", dim(" Authenticate or install a supported CLI, then try again.  Enter/Q quit", options.color));
  } else if (state.view === "picker") lines = pickerScreen(state, options);
  else if (state.view === "setup") lines = setupScreen(state, options);
  else if (state.view === "running" || state.view === "cancelling") {
    lines = state.view === "cancelling"
      ? [yellow(" ◐ CANCELLING · WAITING FOR ACTIVE RUNS TO CLEAN UP", options.color)]
      : runningScreen(state, options);
  } else if (state.view === "results") lines = resultsScreen(state, options);
  else lines = [red(" BENCHMARK ERROR", options.color), "", ` ${clip(state.notice ?? "Unknown error", columns - 2)}`, "", dim(" E edit grid  Enter/Q quit", options.color)];

  return lines.slice(0, rows).map((line) => {
    if (visibleWidth(line) <= columns) return line;
    return clip(stripAnsi(line), columns);
  }).join("\n");
}

export function supportsTerminalTui(input: TuiInput, output: TuiOutput, term = process.env.TERM): boolean {
  return Boolean(
    input.isTTY &&
    output.isTTY &&
    typeof input.setRawMode === "function" &&
    term !== "dumb",
  );
}

function abortError(message = "Benchmark cancelled."): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

class TerminalTuiSession {
  private state = initialTuiState();
  private readonly controller = new AbortController();
  private readonly now: () => number;
  private readonly color: boolean;
  private readonly outcome: Promise<TerminalModeResult>;
  private resolveOutcome!: (result: TerminalModeResult) => void;
  private benchmarkTask: Promise<void> | undefined;
  private frameTimer: ReturnType<typeof setTimeout> | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private viewportProbeTimer: ReturnType<typeof setTimeout> | undefined;
  private viewportProbePending = false;
  private viewportProbeQueued = false;
  private viewportRenderSuspended = false;
  private viewportResponseBuffer = "";
  private measuredColumns: number | undefined;
  private measuredRows: number | undefined;
  private textAreaCandidate: [number, number] | undefined;
  private finished = false;
  private disposed = false;
  private screenEntered = false;
  private rawChanged = false;
  private previousRaw = false;
  private fatalError: unknown;

  private readonly onKeypress = (_text: string, key: TuiKey) => {
    try {
      this.handleKey(key);
    } catch (error) {
      this.fail(error);
    }
  };

  private readonly onResize = () => {
    try {
      this.viewportRenderSuspended = true;
      this.probeViewport();
    } catch (error) {
      this.fail(error);
    }
  };

  private readonly onInputData = (chunk: unknown) => {
    if (!this.viewportProbePending) return;
    const text = Buffer.isBuffer(chunk)
      ? chunk.toString("utf8")
      : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : String(chunk);
    this.viewportResponseBuffer = `${this.viewportResponseBuffer}${text}`.slice(-256);

    const textArea = [...this.viewportResponseBuffer.matchAll(/\u001b\[8;(\d+);(\d+)t/g)].at(-1);
    if (textArea) {
      const rows = Number.parseInt(textArea[1], 10);
      const columns = Number.parseInt(textArea[2], 10);
      if (this.validViewport(columns, rows)) this.textAreaCandidate = [columns, rows];
    }

    const reports = [...this.viewportResponseBuffer.matchAll(/\u001b\[(\d+);(\d+)R/g)];
    const cursor = reports.at(-1);
    if (!cursor) return;
    const rows = Number.parseInt(cursor[1], 10);
    const columns = Number.parseInt(cursor[2], 10);
    if (!this.validViewport(columns, rows)) return;
    this.finishViewportProbe(columns, this.textAreaCandidate?.[1]);
  };

  private readonly onProcessAbort = () => this.cancel();
  private readonly onExternalAbort = () => this.cancel(this.options.signal?.reason);

  constructor(private readonly options: TerminalTuiOptions) {
    this.now = options.now ?? (() => performance.now());
    this.color = options.color ?? (!process.env.NO_COLOR && process.env.TERM !== "dumb");
    this.outcome = new Promise<TerminalModeResult>((resolve) => {
      this.resolveOutcome = resolve;
    });
  }

  private validViewport(columns: number, rows: number): boolean {
    return Number.isInteger(columns) && columns > 0 && columns <= 2_000 &&
      Number.isInteger(rows) && rows > 0 && rows <= 1_000;
  }

  private finishViewportProbe(columns: number, rows?: number): void {
    if (this.viewportProbeTimer) clearTimeout(this.viewportProbeTimer);
    this.viewportProbeTimer = undefined;
    this.viewportProbePending = false;
    this.viewportResponseBuffer = "";
    this.textAreaCandidate = undefined;
    this.measuredColumns = Math.floor(columns);
    this.measuredRows = rows !== undefined && this.validViewport(columns, rows) ? Math.floor(rows) : undefined;
    if (this.viewportProbeQueued) {
      this.viewportProbeQueued = false;
      this.probeViewport();
      return;
    }
    this.viewportRenderSuspended = false;
    this.requestRender(true);
  }

  private probeViewport(): void {
    if (this.finished || this.disposed) return;
    if (this.viewportProbePending) {
      this.viewportProbeQueued = true;
      return;
    }
    if (this.viewportProbeTimer) clearTimeout(this.viewportProbeTimer);
    this.viewportProbePending = true;
    this.viewportResponseBuffer = "";
    this.textAreaCandidate = undefined;
    this.options.output.write(VIEWPORT_QUERY);
    this.viewportProbeTimer = setTimeout(() => {
      this.viewportProbeTimer = undefined;
      if (!this.viewportProbePending) return;
      this.viewportProbePending = false;
      this.viewportResponseBuffer = "";
      const candidate = this.textAreaCandidate;
      this.textAreaCandidate = undefined;
      if (candidate) {
        this.measuredColumns = candidate[0];
        this.measuredRows = candidate[1];
      } else {
        this.measuredColumns = undefined;
        this.measuredRows = undefined;
      }
      if (this.viewportProbeQueued) {
        this.viewportProbeQueued = false;
        this.probeViewport();
        return;
      }
      this.viewportRenderSuspended = false;
      this.requestRender(true);
    }, VIEWPORT_PROBE_TIMEOUT_MS);
    this.viewportProbeTimer.unref?.();
  }

  async run(): Promise<TerminalModeResult> {
    if (this.options.signal?.aborted) return "cancelled";
    try {
      this.enter();
      void this.scan();
      const result = await this.outcome;
      if (result === "cancelled" && this.benchmarkTask) await this.benchmarkTask.catch(() => undefined);
      if (this.fatalError) throw this.fatalError;
      return result;
    } finally {
      this.dispose();
    }
  }

  private enter(): void {
    const { input, output } = this.options;
    this.previousRaw = Boolean(input.isRaw);
    this.screenEntered = true;
    output.write(`${ENTER_SCREEN}\u001b[2J\u001b[H`);
    emitKeypressEvents(input);
    input.on("keypress", this.onKeypress);
    input.on("data", this.onInputData);
    output.on?.("resize", this.onResize);
    if (typeof input.setRawMode === "function") {
      input.setRawMode(true);
      this.rawChanged = true;
    }
    input.resume();
    this.probeViewport();
    if (this.options.handleSigint !== false) {
      process.once("SIGINT", this.onProcessAbort);
      process.once("SIGTERM", this.onProcessAbort);
    }
    if (this.options.signal) this.options.signal.addEventListener("abort", this.onExternalAbort, { once: true });
    this.ticker = setInterval(() => {
      if (this.state.view === "scanning" || this.state.view === "running" || this.state.view === "cancelling") {
        this.requestRender();
      }
    }, 100);
    this.ticker.unref?.();
    this.renderNow();
  }

  private async scan(): Promise<void> {
    try {
      const probed = await this.options.probeAdapters(this.options.adapters);
      if (this.finished || this.controller.signal.aborted) return;
      this.state = withProbeResults(this.state, probed);
      this.requestRender(true);
    } catch (error) {
      if (this.finished) return;
      if (this.controller.signal.aborted) {
        this.finish("cancelled");
        return;
      }
      this.state = { ...this.state, view: "error", notice: safeMessage(error instanceof Error ? error.message : String(error)) };
      this.requestRender(true);
    }
  }

  private handleKey(key: TuiKey): void {
    if (this.finished) return;
    const reduced = reduceTuiKey(this.state, key);
    this.state = reduced.state;
    if (reduced.effect.type === "start") this.startBenchmark();
    else if (reduced.effect.type === "cancel") this.cancel();
    else if (reduced.effect.type === "exit") this.finish(reduced.effect.result);
    this.requestRender(true);
  }

  private startBenchmark(): void {
    if (this.benchmarkTask || this.controller.signal.aborted) return;
    const request = benchmarkRequestFromState(this.state);
    const selected = new Set(request.competitors.map((competitor) => competitor.harness));
    const adapters = this.state.runnable
      .filter(({ adapter }) => selected.has(adapter.id))
      .map(({ adapter }) => adapter);
    this.state = {
      ...this.state,
      view: "running",
      totalRuns: 0,
      completedRuns: 0,
      completedRunKeys: [],
      results: [],
      summary: [],
      issues: [],
      startedAt: this.now(),
      notice: undefined,
      selectedLane: 0,
      lanes: Object.fromEntries(this.state.competitors.map((competitor) => [competitor.id, emptyLane(competitor.id)])),
    };
    this.probeViewport();
    this.requestRender(true);

    const original = this.options.runBenchmark(
      request,
      adapters,
      this.controller.signal,
      (event) => {
        if (this.finished) return;
        this.state = reduceServerEvent(this.state, event, this.now());
        this.requestRender(event.type !== "run.delta");
      },
    );
    this.benchmarkTask = original.then(() => {
      if (this.controller.signal.aborted || this.state.view === "cancelling") {
        this.finish("cancelled");
        return;
      }
      if (this.state.view === "running") {
        this.state = { ...this.state, view: "error", notice: "The benchmark ended without final results." };
        this.requestRender(true);
      }
    }).catch((error) => {
      if (this.controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        this.finish("cancelled");
        return;
      }
      this.state = { ...this.state, view: "error", notice: safeMessage(error instanceof Error ? error.message : String(error)) };
      this.requestRender(true);
    }).finally(() => {
      this.benchmarkTask = undefined;
    });
  }

  private cancel(reason: unknown = abortError()): void {
    if (this.finished || this.controller.signal.aborted) return;
    this.state = { ...this.state, view: "cancelling" };
    this.requestRender(true);
    this.controller.abort(reason);
    if (!this.benchmarkTask) this.finish("cancelled");
  }

  private fail(error: unknown): void {
    if (this.finished) return;
    this.fatalError = error;
    if (!this.controller.signal.aborted) this.controller.abort(error);
    this.finish("cancelled");
  }

  private finish(result: TerminalModeResult): void {
    if (this.finished) return;
    this.finished = true;
    this.resolveOutcome(result);
  }

  private requestRender(immediate = false): void {
    if (this.finished || this.disposed) return;
    if (immediate) {
      if (this.frameTimer) clearTimeout(this.frameTimer);
      this.frameTimer = undefined;
      this.renderNow();
      return;
    }
    if (this.frameTimer) return;
    this.frameTimer = setTimeout(() => {
      this.frameTimer = undefined;
      try {
        this.renderNow();
      } catch (error) {
        this.fail(error);
      }
    }, 80);
    this.frameTimer.unref?.();
  }

  private renderNow(): void {
    if (this.finished || this.disposed || this.viewportRenderSuspended) return;
    const cachedColumns = this.options.output.columns;
    const cachedRows = this.options.output.rows;
    let columns = Number.isFinite(cachedColumns) && (cachedColumns ?? 0) > 0 ? Math.floor(cachedColumns as number) : 100;
    let rows = Number.isFinite(cachedRows) && (cachedRows ?? 0) > 0 ? Math.floor(cachedRows as number) : 30;
    try {
      const fresh = this.options.output.getWindowSize?.();
      if (fresh) {
        const [freshColumns, freshRows] = fresh;
        if (Number.isFinite(freshColumns) && freshColumns > 0) columns = Math.min(columns, Math.floor(freshColumns));
        if (Number.isFinite(freshRows) && freshRows > 0) rows = Math.min(rows, Math.floor(freshRows));
      }
    } catch {
      // Some stream shims expose getWindowSize but throw when detached from a TTY.
    }
    if (this.measuredColumns !== undefined) columns = this.measuredColumns;
    else if (this.viewportProbePending) columns = Math.min(columns, 80);
    if (this.measuredRows !== undefined) rows = this.measuredRows;
    const frame = renderTuiFrame(this.state, {
      columns,
      rows,
      color: this.color,
      now: this.now(),
    });
    const cleared = frame.split("\n").map((line) => `\r\u001b[2K${line}`).join("\n");
    this.options.output.write(`\u001b[H${cleared}\u001b[J`);
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frameTimer) clearTimeout(this.frameTimer);
    if (this.ticker) clearInterval(this.ticker);
    if (this.viewportProbeTimer) clearTimeout(this.viewportProbeTimer);
    this.options.input.removeListener("keypress", this.onKeypress);
    this.options.input.removeListener("data", this.onInputData);
    this.options.output.removeListener?.("resize", this.onResize);
    this.options.signal?.removeEventListener("abort", this.onExternalAbort);
    if (this.options.handleSigint !== false) {
      process.removeListener("SIGINT", this.onProcessAbort);
      process.removeListener("SIGTERM", this.onProcessAbort);
    }
    if (this.rawChanged && typeof this.options.input.setRawMode === "function") {
      this.options.input.setRawMode(this.previousRaw);
    }
    this.options.input.pause();
    if (this.screenEntered) {
      try {
        this.options.output.write(LEAVE_SCREEN);
      } catch {
        // There is no safer recovery path if the terminal output itself has failed.
      }
    }
  }
}

export async function runTerminalTui(options: TerminalTuiOptions): Promise<TerminalModeResult> {
  return new TerminalTuiSession(options).run();
}
