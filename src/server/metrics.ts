import { getEncoding } from "js-tiktoken";
import type { Competitor, RunResult, SummaryRow } from "../shared/types.js";

const tokenizer = getEncoding("o200k_base");

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

function withinOnePercent(value: number, best: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(best)) return false;
  return Math.abs(value - best) / Math.max(Math.abs(best), 0.0001) <= 0.01;
}

export function summarizeResults(competitors: Competitor[], results: RunResult[]): SummaryRow[] {
  const rows = competitors.map((competitor) => {
    const valid = results.filter(
      (result) => result.competitorId === competitor.id && !result.warmup && result.valid,
    );
    return {
      competitor,
      validRuns: valid.length,
      modelTtftMs: median(valid.map((result) => result.metrics.modelTtftMs)),
      coldTtftMs: median(valid.map((result) => result.metrics.coldTtftMs)),
      totalMs: median(valid.map((result) => result.metrics.totalMs)),
      normalizedTps: median(valid.map((result) => result.metrics.normalizedTps)),
      overallRank: 0,
      crowns: [] as SummaryRow["crowns"],
    };
  }).filter((row) => row.validRuns > 0);

  if (rows.length === 0) return [];

  const ranked = [...rows].sort((a, b) => a.totalMs - b.totalMs);
  ranked.forEach((row, index) => {
    row.overallRank = index + 1;
  });

  const bestTotal = Math.min(...rows.map((row) => row.totalMs));
  const bestModelTtft = Math.min(...rows.map((row) => row.modelTtftMs));
  const bestColdTtft = Math.min(...rows.map((row) => row.coldTtftMs));
  const bestTps = Math.max(...rows.map((row) => (Number.isFinite(row.normalizedTps) ? row.normalizedTps : 0)));

  for (const row of rows) {
    if (withinOnePercent(row.totalMs, bestTotal)) row.crowns.push("overall");
    if (withinOnePercent(row.modelTtftMs, bestModelTtft)) row.crowns.push("modelTtft");
    if (withinOnePercent(row.coldTtftMs, bestColdTtft)) row.crowns.push("coldTtft");
    if (withinOnePercent(row.normalizedTps, bestTps)) row.crowns.push("tps");
  }

  return rows.sort((a, b) => a.overallRank - b.overallRank);
}
