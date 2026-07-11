/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import type { BenchmarkSettings } from "../domain/competitors.js";
import type { RacePhase } from "../domain/race-state.js";
import { palette } from "../palette.js";

export interface WorkspaceHeaderProps {
  phase: RacePhase;
  settings: BenchmarkSettings;
  racerCount: number;
  completedRuns: number;
  totalRuns: number;
}

function heading(phase: RacePhase): { eyebrow: string; title: string; color: string } {
  switch (phase) {
    case "running":
      return { eyebrow: "LIVE WORKSPACE", title: "Race in progress", color: palette.green };
    case "complete":
      return { eyebrow: "CLASSIFICATION", title: "Final results", color: palette.green };
    case "cancelled":
      return { eyebrow: "RACE STOPPED", title: "Grid preserved", color: palette.yellow };
    case "error":
      return { eyebrow: "RACE ERROR", title: "Inspect and retry", color: palette.red };
    default:
      return { eyebrow: "STARTING GRID", title: "Choose racers and run", color: palette.accent };
  }
}

export function WorkspaceHeader({
  phase,
  settings,
  racerCount,
  completedRuns,
  totalRuns,
}: WorkspaceHeaderProps) {
  const copy = heading(phase);
  return (
    <box height={4} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1} alignItems="center">
      <box flexDirection="column">
        <text fg={copy.color}>● {copy.eyebrow}</text>
        <text fg={palette.text} attributes={TextAttributes.BOLD}>{copy.title}</text>
      </box>
      <box flexGrow={1} />
      <box flexDirection="column" alignItems="flex-end">
        <text fg={palette.textMuted}>{settings.mode} · {settings.samplePreset}</text>
        <text fg={phase === "running" ? palette.green : palette.textMuted}>
          {phase === "running" ? `${completedRuns}/${totalRuns || "—"} heats` : `${racerCount} lanes`}
        </text>
      </box>
    </box>
  );
}

export interface ActionDockProps {
  phase: RacePhase;
  selectedCount: number;
  active: boolean;
  notice?: string;
  onPrimary: () => void;
  onCommands: () => void;
}

export function ActionDock({
  phase,
  selectedCount,
  active,
  notice,
  onPrimary,
  onCommands,
}: ActionDockProps) {
  const primary = active
    ? { key: "CTRL-C", label: "stop race", color: palette.red }
    : phase !== "idle"
      ? { key: "R", label: "race again", color: palette.green }
      : { key: "ENTER", label: "start race", color: selectedCount ? palette.green : palette.textMuted };

  return (
    <box height={3} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1} alignItems="center">
      <box
        height={2}
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        alignItems="center"
        backgroundColor={palette.panelRaised}
        border={["left"]}
        borderColor={primary.color}
        onMouseUp={onPrimary}
      >
        <text fg={primary.color} attributes={TextAttributes.BOLD}>{primary.key}</text>
        <text fg={palette.text}>  {primary.label}</text>
      </box>
      <text fg={palette.textSubtle}>   {selectedCount} selected</text>
      {notice ? <text fg={palette.red}>   {notice}</text> : null}
      <box flexGrow={1} />
      <box onMouseUp={onCommands}>
        <text fg={palette.textMuted}>ctrl+p  commands</text>
      </box>
    </box>
  );
}
