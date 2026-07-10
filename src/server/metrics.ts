import { getEncoding } from "js-tiktoken";
import type { Competitor, RunResult, SummaryRow } from "../shared/types.js";

const tokenizer = getEncoding("o200k_base");

export const MIN_MEASURABLE_STREAM_MS = 50;

export function countNormalizedTokens(text: string): number {
  return tokenizer.encode(text).length;
}

export function median(values: number[]): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

export function streamAnomalyMessage(deltaCount: number, streamMs: number): string | undefined {
  if (deltaCount <= 1) {
    return "Output arrived as one buffered chunk, so visible streaming speed is not measurable.";
  }
  if (streamMs < MIN_MEASURABLE_STREAM_MS) {
    const duration = streamMs < 1 ? "<1ms" : `${Math.floor(streamMs)}ms`;
    return `Output arrived in a ${duration} burst across ${deltaCount} chunks, so visible streaming speed is not measurable.`;
  }
  return undefined;
}

function withinOnePercent(value: number, best: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(best)) return false;
  return Math.abs(value - best) / Math.max(Math.abs(best), 0.0001) <= 0.01;
}

export function summarizeResults(competitors: Competitor[], results: RunResult[]): SummaryRow[] {
  const rows = competitors.map((competitor) => {
    const measured = results.filter(
      (result) => result.competitorId === competitor.id && !result.warmup,
    );
    const valid = measured.filter((result) => result.valid);
    const summarized = valid.length > 0 ? valid : measured;
    return {
      competitor,
      measuredRuns: measured.length,
      validRuns: valid.length,
      anomalousRuns: measured.length - valid.length,
      disqualified: valid.length === 0,
      promptToFirstOutputMs: median(summarized.map((result) => result.metrics.promptToFirstOutputMs)),
      coldStartToFirstOutputMs: median(summarized.map((result) => result.metrics.coldStartToFirstOutputMs)),
      promptToFinishMs: median(summarized.map((result) => result.metrics.promptToFinishMs)),
      visibleTokensPerSecond: median(summarized.map((result) => result.metrics.visibleTokensPerSecond)),
      finishRank: 0,
      crowns: [] as SummaryRow["crowns"],
    };
  }).filter((row) => row.measuredRuns > 0);

  if (rows.length === 0) return [];

  const ranked = rows.filter((row) => !row.disqualified).sort((a, b) => a.promptToFinishMs - b.promptToFinishMs);
  ranked.forEach((row, index) => {
    row.finishRank = index + 1;
  });

  const bestFinish = Math.min(...ranked.map((row) => row.promptToFinishMs));
  const bestFirstOutput = Math.min(...ranked.map((row) => row.promptToFirstOutputMs));
  const bestColdStart = Math.min(...ranked.map((row) => row.coldStartToFirstOutputMs));
  const bestVisibleSpeed = Math.max(...ranked.map((row) => (Number.isFinite(row.visibleTokensPerSecond) ? row.visibleTokensPerSecond : 0)));

  for (const row of ranked) {
    if (withinOnePercent(row.promptToFinishMs, bestFinish)) row.crowns.push("finish");
    if (withinOnePercent(row.promptToFirstOutputMs, bestFirstOutput)) row.crowns.push("firstOutput");
    if (withinOnePercent(row.coldStartToFirstOutputMs, bestColdStart)) row.crowns.push("coldStart");
    if (withinOnePercent(row.visibleTokensPerSecond, bestVisibleSpeed)) row.crowns.push("visibleSpeed");
  }

  return rows.sort((a, b) => Number(a.disqualified) - Number(b.disqualified) || a.finishRank - b.finishRank);
}
