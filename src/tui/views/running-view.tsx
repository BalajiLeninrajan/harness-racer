import { Box, Text } from "ink";
import type { Competitor } from "../../shared/types.js";
import { formatMs, formatProgressBar, formatRate } from "../format.js";
import { outputTail, raceGridColumns, type TuiLane, type TuiRaceState } from "../model.js";
import { ACCENT, BLUE, MUTED } from "../theme.js";

interface RacePaneProps {
  competitor: Competitor;
  lane: TuiLane;
  focused: boolean;
  pulse: boolean;
  width: number;
  height: number;
}

function RacePane({ competitor, lane, focused, pulse, width, height }: RacePaneProps) {
  const status = lane.status === "complete" ? "HEAT DONE" : lane.status.toUpperCase();
  const statusColor = lane.status === "error" ? "red" : lane.status === "complete" ? BLUE : lane.status === "running" ? ACCENT : MUTED;
  const active = lane.status === "starting" || lane.status === "ready" || lane.status === "running";
  const statusDot = active ? (pulse ? "●" : "○") : lane.status === "error" ? "×" : "●";
  const showMeta = height >= 6;
  const outputRows = Math.max(1, height - 3 - (showMeta ? 1 : 0));
  const waiting = `${lane.workload ?? "waiting for start"}${lane.sample ? ` · ${lane.warmup ? "warmup" : "sample"} ${lane.sample}` : ""}`;
  const visibleOutput = outputTail(lane.error ?? lane.output, Math.max(1, width - 4), outputRows) || waiting;

  return (
    <Box
      width={width}
      height={height}
      minWidth={0}
      borderStyle={focused ? "double" : "round"}
      borderColor={competitor.color}
      paddingX={1}
      flexDirection="column"
      overflow="hidden"
    >
      <Box height={1} justifyContent="space-between">
        <Box minWidth={0}>
          <Text color={lane.status === "error" ? "red" : competitor.color} dimColor={active && !pulse}>{statusDot}</Text>
          <Text bold wrap="truncate-end"> {competitor.label}</Text>
        </Box>
        <Text color={statusColor}> {status}</Text>
      </Box>
      {showMeta && (
        <Text dimColor wrap="truncate-end">{competitor.harness} · {lane.workload ?? "queued"}{lane.sample ? `/s${lane.sample}` : ""} · first {formatMs(lane.firstOutputMs)} · {formatRate(lane.visibleTokensPerSecond)} tok/s</Text>
      )}
      <Text color={lane.error ? "red" : undefined}>{visibleOutput}</Text>
    </Box>
  );
}

export interface RunningViewProps {
  competitors: Competitor[];
  race: TuiRaceState;
  spinner: string;
  columns: number;
  rows: number;
  cursor: number;
  zoomed: boolean;
  pulse: boolean;
}

export function RunningView({ competitors, race, spinner, columns, rows, cursor, zoomed, pulse }: RunningViewProps) {
  const visibleCompetitors = zoomed ? competitors.slice(cursor, cursor + 1) : competitors;
  const gridColumns = zoomed ? 1 : raceGridColumns(columns, competitors.length);
  const chunks: Competitor[][] = [];
  for (let index = 0; index < visibleCompetitors.length; index += gridColumns) chunks.push(visibleCompetitors.slice(index, index + gridColumns));
  const gridHeight = Math.max(5, rows - 4);
  const paneHeight = Math.max(5, Math.floor((gridHeight - Math.max(0, chunks.length - 1)) / Math.max(1, chunks.length)));
  const barWidth = Math.max(8, columns - 38);
  const innerWidth = Math.max(20, columns - 2);

  return (
    <Box flexDirection="column" height={rows} paddingX={1} overflow="hidden" width="100%">
      <Box height={1} justifyContent="space-between">
        <Text bold><Text color={ACCENT}>{spinner} </Text>They’re off.</Text>
        <Text color={ACCENT}>{formatProgressBar(race.completedRuns, race.totalRuns, barWidth)}</Text>
        <Text>{race.completedRuns} / {race.totalRuns || "…"}</Text>
      </Box>
      <Box flexDirection="column" height={gridHeight} rowGap={1} marginTop={1} overflow="hidden">
        {chunks.map((chunk, rowIndex) => {
          const paneWidth = Math.floor((innerWidth - Math.max(0, chunk.length - 1)) / chunk.length);
          return (
            <Box key={rowIndex} height={paneHeight} columnGap={1} minHeight={0} overflow="hidden">
              {chunk.map((competitor) => {
                const actualIndex = competitors.findIndex((candidate) => candidate.id === competitor.id);
                return (
                  <RacePane
                    key={competitor.id}
                    competitor={competitor}
                    lane={race.lanes[competitor.id] ?? { status: "queued", output: "", completedRuns: 0 }}
                    focused={actualIndex === cursor}
                    pulse={pulse}
                    width={paneWidth}
                    height={paneHeight}
                  />
                );
              })}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} height={1} justifyContent="space-between">
        <Text dimColor>h/j/k/l pane  enter/z {zoomed ? "overview" : "zoom"}  esc {zoomed ? "overview" : "cancel"}  ctrl+c quit</Text>
        {race.error && <Text color="red">{race.error}</Text>}
      </Box>
    </Box>
  );
}
