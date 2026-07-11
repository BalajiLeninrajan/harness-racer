/** @jsxImportSource @opentui/react */
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import type { SummaryRow } from "../../shared/types.js";
import type { BenchmarkSettings } from "../domain/competitors.js";
import {
  classificationEntries,
  crown,
  expectedMeasured,
  place,
  placeColor,
  range,
  workloadDetail,
  type ClassificationEntry,
  type WorkloadDetail,
} from "../domain/results.js";
import type { RaceState } from "../domain/race-state.js";
import { palette } from "../palette.js";
import { sanitizeTerminalText } from "../sanitize.js";
import { formatCount, formatMs, formatRate } from "../text.js";

export interface LeaderboardProps {
  competitors: ClassificationEntry["competitor"][];
  state: RaceState;
  settings: BenchmarkSettings;
  selectedIndex: number;
  width: number;
  height: number;
  focused: boolean;
  onSelect: (index: number) => void;
}

function crownLabel(row: SummaryRow | undefined): string {
  if (!row?.crowns.length) return "";
  return row.crowns.map((metric) => ({
    finish: "overall",
    firstOutput: "first output",
    coldStart: "cold start",
    visibleSpeed: "TPS",
  })[metric]).join(" · ");
}

function MetricLine({ label, detail }: { label: string; detail: WorkloadDetail }) {
  return (
    <box flexDirection="column" paddingBottom={1}>
      <box height={1} flexDirection="row">
        <text fg={palette.accent} attributes={TextAttributes.BOLD}>{label.toUpperCase()}</text>
        <box flexGrow={1} />
        <text fg={detail.valid === detail.recorded ? palette.green : palette.yellow}>
          {detail.valid}/{detail.recorded} valid
        </text>
      </box>
      <text fg={palette.text}>finish  {range(detail)}</text>
      <text fg={palette.textMuted}>
        first   {formatMs(detail.firstMs)}   speed  {formatRate(detail.rate)} tok/s
      </text>
      <text fg={palette.textMuted}>
        setup   {formatMs(detail.prepMs)}   stream {formatMs(detail.streamMs)}   {formatCount(detail.chunks)} chunks
      </text>
    </box>
  );
}

function ResultDetail({
  entry,
  winner,
  state,
  settings,
}: {
  entry: ClassificationEntry;
  winner?: SummaryRow;
  state: RaceState;
  settings: BenchmarkSettings;
}) {
  const row = entry.summary;
  const measured = state.results.filter((result) =>
    result.competitorId === entry.competitor.id && !result.warmup
  );
  const prose = workloadDetail(measured, "prose", Boolean(row?.disqualified));
  const code = workloadDetail(measured, "code", Boolean(row?.disqualified));
  const invalid = measured.filter((result) => !result.valid);
  const issues = state.issues.filter((issue) => issue.competitorId === entry.competitor.id);
  const missing = Math.max(0, expectedMeasured(settings) - measured.length);
  const gap = row && winner && !row.disqualified
    ? Math.max(0, row.promptToFinishMs - winner.promptToFinishMs)
    : undefined;
  const problems: string[] = [];

  if (!row) problems.push("No measured result was recorded.");
  if (row?.disqualified) problems.push("Not ranked: every measured output was anomalous.");
  if (invalid.length) {
    problems.push(`${invalid.length} anomalous run${invalid.length === 1 ? "" : "s"}: ${sanitizeTerminalText(
      invalid[0].validationMessage ?? "invalid output",
      "invalid output",
      160,
    )}`);
  }
  if (issues.length) {
    problems.push(`${issues.length} error${issues.length === 1 ? "" : "s"}: ${sanitizeTerminalText(
      issues[0].message,
      "unknown error",
      160,
    )}`);
  }
  if (missing) problems.push(`${missing} measured run${missing === 1 ? "" : "s"} missing.`);

  return (
    <scrollbox
      flexGrow={1}
      minHeight={0}
      scrollY
      scrollbarOptions={{ visible: false }}
      backgroundColor={palette.panelRaised}
      border={["left"]}
      borderColor={entry.competitor.color}
      padding={1}
    >
      <box flexDirection="column" paddingBottom={1}>
        <box height={2} flexDirection="row" alignItems="center" overflow="hidden">
          <text fg={placeColor(entry)} attributes={TextAttributes.BOLD}>{place(entry)}</text>
          <text fg={palette.text} attributes={TextAttributes.BOLD}>  {entry.competitor.label}</text>
        </box>
        <text fg={row && !row.disqualified ? palette.green : palette.red}>
          {row && !row.disqualified
            ? row.finishRank === 1
              ? "Winner"
              : `${formatMs(gap)} behind P1`
            : "Did not finish"}
        </text>
      </box>

      <MetricLine label="Prose" detail={prose} />
      <MetricLine label="Code" detail={code} />

      {row?.crowns.length ? (
        <box flexDirection="column" paddingTop={1} paddingBottom={1}>
          <text fg={palette.green}>★ BEST IN</text>
          <text fg={palette.text}>{crownLabel(row)}</text>
        </box>
      ) : null}

      {problems.length ? (
        <box
          flexDirection="column"
          padding={1}
          border={["left"]}
          borderColor={row?.disqualified || issues.length ? palette.red : palette.yellow}
          backgroundColor={palette.panel}
        >
          {problems.map((problem) => (
            <text key={problem} fg={row?.disqualified || issues.length ? palette.red : palette.yellow}>
              {problem}
            </text>
          ))}
        </box>
      ) : null}
    </scrollbox>
  );
}

export function Leaderboard({
  competitors,
  state,
  settings,
  selectedIndex,
  width,
  height,
  focused,
  onSelect,
}: LeaderboardProps) {
  const listRef = useRef<ScrollBoxRenderable>(null);
  const entries = classificationEntries(competitors, state);
  const selected = entries[Math.min(selectedIndex, Math.max(0, entries.length - 1))];
  const winner = state.summary.find((row) => !row.disqualified);
  // Side-by-side results need enough room for both a readable leaderboard and
  // the metrics card. Around an 80-column terminal, stack them instead.
  const wide = width >= 96;
  const maxNarrowListHeight = height > 3 ? height - 3 : Math.max(1, height - 1);
  const listHeight = wide
    ? "100%"
    : Math.min(
        entries.length * 2 + 2,
        maxNarrowListHeight,
        Math.max(1, Math.floor(height * 0.45)),
      );

  useEffect(() => {
    listRef.current?.scrollChildIntoView(`result-${selectedIndex}`);
  }, [selectedIndex]);

  if (!selected) {
    return <text fg={palette.red}>No competitors were classified.</text>;
  }

  return (
    <box flexGrow={1} minHeight={0} flexDirection={wide ? "row" : "column"} gap={1}>
      <scrollbox
        ref={listRef}
        width={wide ? Math.max(31, Math.floor(width * 0.42)) : "100%"}
        height={listHeight}
        flexShrink={0}
        scrollY
        scrollbarOptions={{ visible: false }}
        backgroundColor={palette.panel}
        paddingTop={1}
      >
        <text fg={palette.textMuted}>  LEADERBOARD</text>
        {entries.map((entry, index) => {
          const row = entry.summary;
          const active = index === selectedIndex;
          const valid = row?.validRuns ?? 0;
          const total = row?.measuredRuns ?? expectedMeasured(settings);
          return (
            <box
              id={`result-${index}`}
              key={entry.competitor.id}
              height={2}
              flexShrink={0}
              flexDirection="row"
              alignItems="center"
              paddingLeft={1}
              paddingRight={1}
              onMouseUp={() => onSelect(index)}
            >
              <text fg={active && focused ? palette.accent : palette.panel}>{active && focused ? "▎" : " "}</text>
              <text fg={placeColor(entry)} attributes={TextAttributes.BOLD}>{place(entry).padEnd(3)}</text>
              <box height={1} flexGrow={1} minWidth={0} overflow="hidden">
                <text
                  fg={active ? palette.text : palette.textMuted}
                  attributes={active ? TextAttributes.BOLD : 0}
                  wrapMode="none"
                >
                  {" "}{entry.competitor.label}
                </text>
              </box>
              <text fg={valid === total ? palette.green : palette.yellow}>{valid}/{total}</text>
              <text fg={palette.textMuted}>  {crown(row, "finish")}{formatMs(row?.promptToFinishMs)}</text>
            </box>
          );
        })}
      </scrollbox>

      <ResultDetail entry={selected} winner={winner} state={state} settings={settings} />
    </box>
  );
}
