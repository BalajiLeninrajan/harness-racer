import { Box, Text } from "ink";
import type { SummaryRow } from "../../shared/types.js";
import { formatMs, formatRate } from "../format.js";
import type { TuiRaceState } from "../model.js";
import { ACCENT, BLUE, MUTED, ORANGE, YELLOW } from "../theme.js";
import { Footer, Header } from "./chrome.js";

interface ResultMetricProps {
  width: number;
  value: string;
  best: boolean;
}

function ResultMetric({ width, value, best }: ResultMetricProps) {
  return (
    <Box width={width}>
      <Text bold={best} color={best ? ACCENT : undefined}>{value}{best ? " ★" : ""}</Text>
    </Box>
  );
}

function resultRankColor(row: SummaryRow): string | undefined {
  if (row.disqualified) return "red";
  if (row.finishRank === 1) return YELLOW;
  if (row.finishRank === 2) return "#bac2de";
  if (row.finishRank === 3) return ORANGE;
  return undefined;
}

export interface ResultsViewProps {
  race: TuiRaceState;
  columns: number;
  rows?: number;
}

export function ResultsView({ race, columns, rows = 24 }: ResultsViewProps) {
  const eligible = race.summary.filter((row) => !row.disqualified);
  const winner = eligible.find((row) => row.finishRank === 1) ?? eligible[0];
  const veryCompact = rows < 20;
  const dense = rows < 26;
  const showColdStart = columns >= 76;
  const rankWidth = 4;
  const firstWidth = 9;
  const coldWidth = 9;
  const rateWidth = 10;
  const finishWidth = 9;
  const fixedWidth = rankWidth + firstWidth + rateWidth + finishWidth + (showColdStart ? coldWidth : 0);
  const fieldCount = showColdStart ? 6 : 5;
  const racerWidth = Math.max(14, columns - 6 - fixedWidth - (fieldCount - 1));
  const validRuns = race.summary.reduce((total, row) => total + row.validRuns, 0);
  const disqualified = race.summary.filter((row) => row.disqualified).length;

  return (
    <Box flexDirection="column" paddingY={dense ? 0 : 1} paddingX={1} width="100%">
      {veryCompact ? (
        <Box justifyContent="space-between">
          <Text bold color={BLUE}>Photo finish.</Text>
          <Text dimColor>4 · results</Text>
        </Box>
      ) : (
        <>
          <Header phase="results" />
          <Text bold color={BLUE}>Photo finish.</Text>
          <Text dimColor>Median results across valid prose and code runs.</Text>
        </>
      )}
      {race.error && <Text color="red">{race.error}</Text>}

      {!veryCompact && winner && (
        <Box flexDirection="column" borderStyle="round" borderColor={winner.competitor.color} paddingX={2} marginTop={1}>
          <Box justifyContent="space-between">
            <Box minWidth={0} flexGrow={1}>
              <Text bold color={YELLOW}>★ WINNER  </Text>
              <Text color={winner.competitor.color}>● </Text>
              <Text bold wrap="truncate-end">{winner.competitor.label}</Text>
              <Text dimColor> · {winner.competitor.harness}</Text>
            </Box>
            <Text dimColor>{winner.validRuns}/{winner.measuredRuns} valid</Text>
          </Box>
          <Box columnGap={3}>
            <Text dimColor>finish <Text bold color={winner.crowns.includes("finish") ? ACCENT : undefined}>{formatMs(winner.promptToFinishMs)}</Text></Text>
            <Text dimColor>first <Text bold color={winner.crowns.includes("firstOutput") ? ACCENT : undefined}>{formatMs(winner.promptToFirstOutputMs)}</Text></Text>
            <Text dimColor>speed <Text bold color={winner.crowns.includes("visibleSpeed") ? ACCENT : undefined}>{formatRate(winner.visibleTokensPerSecond)} tok/s</Text></Text>
          </Box>
        </Box>
      )}

      {race.summary.length > 0 && (
        <Box flexDirection="column" borderStyle="round" borderColor={MUTED} paddingX={1} marginTop={veryCompact ? 0 : 1}>
          <Box justifyContent="space-between" marginBottom={veryCompact ? 0 : 1}>
            <Text bold color={BLUE}>{veryCompact ? "STANDINGS" : "FULL CLASSIFICATION"}</Text>
            <Text dimColor>{veryCompact
              ? `${race.summary.length} racers${disqualified ? ` · ${disqualified} DQ` : ""}`
              : `${validRuns} valid runs${disqualified ? ` · ${disqualified} DQ` : ""} · ★ best`}</Text>
          </Box>
          <Box columnGap={1}>
            <Box width={rankWidth}><Text dimColor>Rank</Text></Box>
            <Box width={racerWidth}><Text dimColor>Racer</Text></Box>
            <Box width={firstWidth}><Text dimColor>First</Text></Box>
            {showColdStart && <Box width={coldWidth}><Text dimColor>Cold</Text></Box>}
            <Box width={rateWidth}><Text dimColor>Tok/s</Text></Box>
            <Box width={finishWidth}><Text dimColor>Finish</Text></Box>
          </Box>
          {race.summary.map((row) => (
            <Box key={row.competitor.id} columnGap={1}>
              <Box width={rankWidth}><Text bold={row.finishRank <= 3} color={resultRankColor(row)}>{row.disqualified ? "DQ" : `#${row.finishRank}`}</Text></Box>
              <Box width={racerWidth} minWidth={0}>
                <Text wrap="truncate-end"><Text color={row.competitor.color}>● </Text><Text bold>{row.competitor.label}</Text><Text dimColor> · {row.competitor.harness}</Text></Text>
              </Box>
              <ResultMetric width={firstWidth} value={formatMs(row.promptToFirstOutputMs)} best={row.crowns.includes("firstOutput")} />
              {showColdStart && <ResultMetric width={coldWidth} value={formatMs(row.coldStartToFirstOutputMs)} best={row.crowns.includes("coldStart")} />}
              <ResultMetric width={rateWidth} value={formatRate(row.visibleTokensPerSecond)} best={row.crowns.includes("visibleSpeed")} />
              <ResultMetric width={finishWidth} value={formatMs(row.promptToFinishMs)} best={row.crowns.includes("finish")} />
            </Box>
          ))}
        </Box>
      )}
      {!race.summary.length && <Text color={YELLOW}>No racers produced rankable results.</Text>}
      {veryCompact
        ? <Box><Text dimColor>r race again  enter/q exit</Text></Box>
        : <Footer>r race again  enter/q exit</Footer>}
    </Box>
  );
}
