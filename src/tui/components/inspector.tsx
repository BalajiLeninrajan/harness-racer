/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import type { Competitor } from "../../shared/types.js";
import type { BenchmarkSettings } from "../domain/competitors.js";
import { expectedMeasured } from "../domain/results.js";
import type { RaceState } from "../domain/race-state.js";
import { palette } from "../palette.js";
import { formatMs, formatRate } from "../text.js";

export interface InspectorProps {
  competitors: readonly Competitor[];
  state: RaceState;
  settings: BenchmarkSettings;
  focusedId?: string;
}

function phaseLabel(state: RaceState): { label: string; color: string } {
  switch (state.phase) {
    case "running":
      return { label: "RACE LIVE", color: palette.green };
    case "complete":
      return { label: "RESULTS READY", color: palette.green };
    case "cancelled":
      return { label: "CANCELLED", color: palette.yellow };
    case "error":
      return { label: "RACE ERROR", color: palette.red };
    default:
      return { label: "GRID READY", color: palette.green };
  }
}

export function Inspector({ competitors, state, settings, focusedId }: InspectorProps) {
  const phase = phaseLabel(state);
  const focused = competitors.find((competitor) => competitor.id === focusedId) ?? competitors[0];
  const focusedLane = focused ? state.lanes[focused.id] : undefined;
  const winner = state.summary.find((row) => !row.disqualified);
  const valid = state.summary.reduce((sum, row) => sum + row.validRuns, 0);
  const expected = expectedMeasured(settings) * competitors.length;

  return (
    <box
      width={31}
      height="100%"
      flexShrink={0}
      flexDirection="column"
      backgroundColor={palette.panel}
      border={["left"]}
      borderColor={palette.border}
      padding={1}
    >
      <box height={3} flexShrink={0} flexDirection="column">
        <text fg={phase.color}>● {phase.label}</text>
        <text fg={palette.textMuted}>{settings.mode} · {settings.samplePreset}</text>
      </box>

      <box flexDirection="column" flexShrink={0} paddingBottom={1}>
        <text fg={palette.textMuted}>PROGRESS</text>
        <box height={1} flexDirection="row" backgroundColor={palette.element}>
          <box
            height={1}
            width={`${state.totalRuns ? Math.round((state.completedRuns / state.totalRuns) * 100) : 0}%`}
            backgroundColor={palette.green}
          />
        </box>
        <text fg={palette.text}>{state.completedRuns}/{state.totalRuns || "—"} heats complete</text>
      </box>

      {state.phase === "complete" ? (
        <box flexDirection="column" flexShrink={0} paddingTop={1} paddingBottom={1}>
          <text fg={palette.textMuted}>CLASSIFICATION</text>
          <text fg={winner ? palette.gold : palette.red} attributes={TextAttributes.BOLD}>
            {winner ? `P1  ${winner.competitor.label}` : "NO FINISHER"}
          </text>
          <text fg={valid === expected ? palette.green : palette.yellow}>{valid}/{expected} valid outputs</text>
        </box>
      ) : null}

      <box flexDirection="column" flexShrink={0} paddingTop={1}>
        <text fg={palette.textMuted}>FOCUSED PANE</text>
        <text fg={focused?.color ?? palette.text} attributes={TextAttributes.BOLD}>
          {focused?.label ?? "None"}
        </text>
        <text fg={palette.textMuted}>
          {focusedLane?.workload ?? "idle"} · {focusedLane?.warmup ? "warmup" : `sample ${focusedLane?.sample ?? "—"}`}
        </text>
        <text fg={palette.textMuted} wrapMode="none">
          TTFT <span fg={palette.cyan}>{formatMs(focusedLane?.ttftMs)}</span>
          {"   "}TPS <span fg={palette.green}>{formatRate(focusedLane?.liveTps)}</span>
        </text>
      </box>

      <box flexGrow={1} />
      {state.notice ? (
        <box border={["left"]} borderColor={palette.red} paddingLeft={1}>
          <text fg={palette.red}>{state.notice}</text>
        </box>
      ) : null}
      <text fg={palette.textSubtle}>tab focus · mouse scroll</text>
    </box>
  );
}
