import type { SummaryRow } from "../shared/types";
import { HARNESS_LABELS, formatMs, formatVisibleRate } from "./benchmark";

/* The finish chart's time axis: a round step that gives at most five
   intervals, and an end one step past the slowest median or on it. */
export function finishAxis(slowestMs: number): { scaleMs: number; ticksMs: number[] } {
  const steps = [250, 500, 1000, 2000, 5000, 10_000, 20_000, 30_000, 60_000, 120_000, 300_000];
  const target = Math.max(slowestMs, 1);
  const step = steps.find((candidate) => target / candidate <= 5) ?? Math.ceil(target / 5 / 60_000) * 60_000;
  const scaleMs = Math.ceil(target / step) * step;
  const ticksMs = Array.from({ length: scaleMs / step + 1 }, (_, index) => index * step);
  return { scaleMs, ticksMs };
}

export const harnessLabel = (row: SummaryRow) => HARNESS_LABELS[row.competitor.harness];

/* "GPT-5 in Codex": the stack named by what the user picked. */
export const stackName = (row: SummaryRow) => `${row.competitor.label} in ${harnessLabel(row)}`;

const joinPhrases = (phrases: string[]) =>
  phrases.length < 2 ? phrases.join("") : `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`;

/* The race in sentences: who took the other bests, and what the harness
   alone cost when one model ran in two harnesses. Ranked rows only. The
   server crowns every stack within 1% of a best, so a best can be shared;
   the sentence then names every holder and quotes the best value. */
export function summarySentences(ranked: SummaryRow[]): string[] {
  const winner = ranked[0];
  if (!winner) return [];

  const bests: Array<{ crown: SummaryRow["crowns"][number]; score: (row: SummaryRow) => number; phrase: (row: SummaryRow) => string }> = [
    { crown: "firstOutput", score: (row) => row.promptToFirstOutputMs, phrase: (row) => `the fastest first output at ${formatMs(row.promptToFirstOutputMs)}` },
    { crown: "coldStart", score: (row) => row.coldStartToFirstOutputMs, phrase: (row) => `the quickest cold start at ${formatMs(row.coldStartToFirstOutputMs)}` },
    { crown: "visibleSpeed", score: (row) => -row.visibleTokensPerSecond, phrase: (row) => `the fastest stream at ${formatVisibleRate(row.visibleTokensPerSecond)} tok/s` },
  ];
  const byHolders = new Map<string, { rows: SummaryRow[]; phrases: string[] }>();
  for (const best of bests) {
    const holders = ranked.filter((row) => row.crowns.includes(best.crown));
    if (holders.length === 0) continue;
    const top = holders.reduce((a, b) => (best.score(b) < best.score(a) ? b : a));
    const key = holders.map((row) => row.competitor.id).join(" ");
    const group = byHolders.get(key) ?? { rows: holders, phrases: [] };
    group.phrases.push(best.phrase(top));
    byHolders.set(key, group);
  }

  const sentences = [...byHolders.values()].map(({ rows, phrases }) => {
    if (rows.length > 1) return `${joinPhrases(rows.map((row) => (row === winner ? "The winner" : stackName(row))))} shared ${joinPhrases(phrases)}.`;
    return rows[0] === winner ? `The winner also had ${joinPhrases(phrases)}.` : `${stackName(rows[0])} had ${joinPhrases(phrases)}.`;
  });

  for (const [index, faster] of ranked.entries()) {
    const slower = ranked.slice(index + 1).find((row) => row.competitor.model === faster.competitor.model && row.competitor.harness !== faster.competitor.harness);
    if (!slower) continue;
    sentences.push(`Run through ${harnessLabel(slower)} instead of ${harnessLabel(faster)}, ${faster.competitor.label} finished ${formatMs(slower.promptToFinishMs - faster.promptToFinishMs)} later.`);
    break;
  }
  return sentences;
}
