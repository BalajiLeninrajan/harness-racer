import type {
  Competitor,
  RunResult,
  SummaryRow,
  WorkloadId,
} from "../../shared/types.js";
import { formatMs } from "../text.js";
import type { BenchmarkSettings } from "./competitors.js";
import type { RaceState } from "./race-state.js";

export interface ClassificationEntry {
  competitor: Competitor;
  summary?: SummaryRow;
}

export interface WorkloadDetail {
  valid: number;
  recorded: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  firstMs: number;
  rate: number;
  prepMs: number;
  streamMs: number;
  chunks: number;
}

export type CrownMetric = SummaryRow["crowns"][number];

/** Keep ranked finishers first, then append competitors without a summary as DNFs. */
export function classificationEntries(
  competitors: readonly Competitor[],
  state: Pick<RaceState, "summary">,
): ClassificationEntry[] {
  const summarized = new Set(state.summary.map((row) => row.competitor.id));
  return [
    ...state.summary.map((summary) => ({ competitor: summary.competitor, summary })),
    ...competitors
      .filter((competitor) => !summarized.has(competitor.id))
      .map((competitor) => ({ competitor })),
  ];
}

function median(values: readonly number[]): number {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return Number.POSITIVE_INFINITY;

  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Aggregate the measured samples for one workload into the values shown in racer details. */
export function workloadDetail(
  results: readonly RunResult[],
  workload: WorkloadId,
  includeInvalid: boolean,
): WorkloadDetail {
  const recorded = results.filter((result) => !result.warmup && result.workload === workload);
  const valid = recorded.filter((result) => result.valid);
  const source = includeInvalid && !valid.length ? recorded : valid;
  const totals = source
    .map((result) => result.metrics.promptToFinishMs)
    .filter(Number.isFinite);

  return {
    valid: valid.length,
    recorded: recorded.length,
    totalMs: median(totals),
    minMs: totals.length ? Math.min(...totals) : Number.POSITIVE_INFINITY,
    maxMs: totals.length ? Math.max(...totals) : Number.POSITIVE_INFINITY,
    firstMs: median(source.map((result) => result.metrics.promptToFirstOutputMs)),
    rate: median(source.map((result) => result.metrics.visibleTokensPerSecond)),
    prepMs: median(source.map((result) => result.metrics.harnessPrepMs)),
    streamMs: median(source.map((result) => result.metrics.visibleStreamMs)),
    chunks: median(source.map((result) => result.metrics.streamChunkCount)),
  };
}

/** Number of non-warmup runs expected for each competitor. */
export function expectedMeasured(settings: Pick<BenchmarkSettings, "samplePreset">): number {
  const samplesPerWorkload = settings.samplePreset === "quick"
    ? 1
    : settings.samplePreset === "standard"
      ? 3
      : 5;
  return samplesPerWorkload * 2;
}

export function place(entry: ClassificationEntry): string {
  if (!entry.summary) return "DNF";
  if (entry.summary.disqualified) return "DSQ";
  return `P${entry.summary.finishRank}`;
}

export function placeColor(entry: ClassificationEntry): string {
  if (!entry.summary || entry.summary.disqualified) return "#ff5f5f";
  if (entry.summary.finishRank === 1) return "#ffd700";
  if (entry.summary.finishRank === 2) return "#bcbcbc";
  if (entry.summary.finishRank === 3) return "#d7875f";
  return entry.competitor.color;
}

export function crown(row: SummaryRow | undefined, metric: CrownMetric): string {
  return row?.crowns.includes(metric) ? "★" : "";
}

export function range(detail: WorkloadDetail): string {
  if (!Number.isFinite(detail.totalMs)) return "—";
  return `${formatMs(detail.totalMs)} (${formatMs(detail.minMs)}–${formatMs(detail.maxMs)})`;
}
