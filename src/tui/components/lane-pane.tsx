/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import type { Competitor } from "../../shared/types.js";
import type { RaceLane } from "../domain/race-state.js";
import { palette } from "../palette.js";
import { formatMs, formatRate } from "../text.js";

const STATUS: Record<RaceLane["status"], { label: string; color: string }> = {
  queued: { label: "READY", color: palette.green },
  starting: { label: "START", color: palette.yellow },
  ready: { label: "READY", color: palette.green },
  running: { label: "LIVE", color: palette.green },
  complete: { label: "DONE", color: palette.green },
  invalid: { label: "CHECK", color: palette.yellow },
  error: { label: "ERROR", color: palette.red },
};

export interface LanePaneProps {
  competitor: Competitor;
  lane: RaceLane;
  index: number;
  expectedRuns: number;
  focused: boolean;
  onFocus: () => void;
}

function heatLabel(lane: RaceLane): string {
  if (!lane.workload) return "waiting for race";
  return `${lane.workload}  ${lane.warmup ? "warmup" : `sample ${lane.sample ?? 1}`}`;
}

export function LanePane({
  competitor,
  lane,
  index,
  expectedRuns,
  focused,
  onFocus,
}: LanePaneProps) {
  const status = STATUS[lane.status];
  const rail = lane.status === "error"
    ? palette.red
    : lane.status === "invalid"
      ? palette.yellow
      : focused
        ? competitor.color
        : palette.border;
  const output = lane.error || lane.output || (lane.status === "queued"
    ? "Ready. Start the race when the grid looks right."
    : "Waiting for visible output…");
  const showScrollbar = focused && (
    lane.output.length > 500 || lane.output.split("\n").length > 8
  );

  return (
    <box
      flexGrow={1}
      flexBasis={0}
      minWidth={0}
      minHeight={0}
      flexDirection="column"
      backgroundColor={focused ? palette.panelRaised : palette.panel}
      border={["left"]}
      borderColor={rail}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      onMouseDown={onFocus}
    >
      <box height={1} flexShrink={0} flexDirection="row" alignItems="center" overflow="hidden">
        <box width={4} flexShrink={0}>
          <text fg={competitor.color} attributes={TextAttributes.BOLD}>
            {String(index + 1).padStart(2, "0")}{"  "}
          </text>
        </box>
        <box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          <text fg={palette.text} attributes={TextAttributes.BOLD} wrapMode="none">{competitor.label}</text>
        </box>
        <box width={9} flexShrink={0} flexDirection="row" justifyContent="flex-end">
          <text fg={status.color} wrapMode="none">{"  "}● {status.label}</text>
        </box>
      </box>

      <box height={2} flexShrink={0} flexDirection="column" overflow="hidden">
        <text fg={palette.textMuted} wrapMode="none">{heatLabel(lane)}</text>
        <text fg={palette.textMuted} wrapMode="none">
          TTFT <span fg={palette.cyan}>{formatMs(lane.ttftMs)}</span>
          {"  ·  "}TPS <span fg={palette.green}>{formatRate(lane.liveTps)}</span>
          <span fg={palette.textSubtle}>{"  ·  "}{lane.completedRuns}/{expectedRuns}</span>
        </text>
      </box>

      <scrollbox
        focused={focused}
        flexGrow={1}
        minHeight={0}
        scrollY
        stickyScroll
        stickyStart="bottom"
        viewportOptions={{ paddingRight: 1 }}
        verticalScrollbarOptions={{
          visible: showScrollbar,
          trackOptions: {
            backgroundColor: palette.panel,
            foregroundColor: palette.borderStrong,
          },
        }}
      >
        <text
          fg={lane.error ? palette.red : lane.output ? palette.text : palette.textMuted}
          wrapMode="word"
          selectable
        >
          {output}
        </text>
      </scrollbox>
    </box>
  );
}
