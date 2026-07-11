/** @jsxImportSource @opentui/react */
import type { Competitor } from "../../shared/types.js";
import type { BenchmarkSettings } from "../domain/competitors.js";
import { paneColumnCount, paneRows } from "../domain/layout.js";
import type { RaceLane, RaceState } from "../domain/race-state.js";
import { LanePane } from "./lane-pane.js";

export interface RaceGridProps {
  competitors: readonly Competitor[];
  state: RaceState;
  settings: BenchmarkSettings;
  width: number;
  focusedIndex: number;
  onFocus: (index: number) => void;
}

function expectedRuns(preset: BenchmarkSettings["samplePreset"]): number {
  return preset === "quick" ? 2 : preset === "standard" ? 8 : 12;
}

function fallbackLane(competitorId: string): RaceLane {
  return {
    competitorId,
    status: "queued",
    output: "",
    completedRuns: 0,
  };
}

export function RaceGrid({
  competitors,
  state,
  settings,
  width,
  focusedIndex,
  onFocus,
}: RaceGridProps) {
  const columnCount = paneColumnCount(competitors.length, width);
  const rows = paneRows(competitors, columnCount);
  const runs = expectedRuns(settings.samplePreset);

  return (
    <box flexGrow={1} minHeight={0} flexDirection="column" gap={1}>
      {rows.map((row, rowIndex) => (
        <box
          key={`row-${rowIndex}`}
          flexGrow={1}
          flexBasis={0}
          minHeight={0}
          flexDirection="row"
          gap={1}
        >
          {row.map((competitor, columnIndex) => {
            if (!competitor) {
              return <box key={`empty-${rowIndex}-${columnIndex}`} flexGrow={1} flexBasis={0} minWidth={0} />;
            }
            const index = rowIndex * columnCount + columnIndex;
            return (
              <LanePane
                key={competitor.id}
                competitor={competitor}
                lane={state.lanes[competitor.id] ?? fallbackLane(competitor.id)}
                index={index}
                expectedRuns={runs}
                focused={index === focusedIndex}
                onFocus={() => onFocus(index)}
              />
            );
          })}
        </box>
      ))}
    </box>
  );
}
