import { Box, Text, render, useApp, useInput, useWindowSize } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Competitor, ProviderInfo, RunMode, SamplePreset, SummaryRow } from "../shared/types.js";
import { adapters } from "../server/adapters/index.js";
import { getProviders } from "../server/app.js";
import { runBenchmark } from "../server/benchmark.js";
import {
  configureActivation,
  competitorsFromSelection,
  defaultSelection,
  emptyRaceState,
  filterRacerOptions,
  outputTail,
  raceGridColumns,
  racerOptions,
  reduceRaceEvent,
  TUI_COLORS,
  type RacerOption,
  type TuiLane,
  type TuiRaceState,
} from "./model.js";

type Phase = "loading" | "lineup" | "picker" | "configure" | "running" | "results" | "error";
type PickerFocus = "providers" | "models";

interface PickerState {
  slot: number;
  providerCursor: number;
  modelCursor: number;
  focus: PickerFocus;
  query: string;
  searching: boolean;
}

const ACCENT = "#cba6f7";
const YELLOW = "#f9e2af";
const BLUE = "#89b4fa";
const MUTED = "#7f849c";
const FOCUS_BACKGROUND = "#313244";

function formatMs(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}s` : `${Math.round(value)}ms`;
}

function formatRate(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(value >= 100 ? 0 : 1);
}

function useSpinner(active: boolean): string {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setFrame((value) => (value + 1) % frames.length), 80);
    return () => clearInterval(timer);
  }, [active, frames.length]);
  return frames[frame];
}

function usePulse(active: boolean): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (!active) {
      setVisible(true);
      return;
    }
    const timer = setInterval(() => setVisible((current) => !current), 800);
    return () => clearInterval(timer);
  }, [active]);
  return visible;
}

function Header({ phase }: { phase: Phase }) {
  const step = phase === "lineup" || phase === "picker"
    ? "1 · racers"
    : phase === "configure"
      ? "2 · grid"
      : phase === "results"
        ? "4 · results"
        : "terminal mode";
  return (
    <Box justifyContent="space-between" marginBottom={1}>
      <Text bold color={ACCENT}>harness.racer</Text>
      <Text dimColor>{step}</Text>
    </Box>
  );
}

function Footer({ children }: { children: React.ReactNode }) {
  return <Box marginTop={1}><Text dimColor>{children}</Text></Box>;
}

function LoadingView({ spinner }: { spinner: string }) {
  return (
    <Box flexDirection="column" padding={1} width="100%">
      <Header phase="loading" />
      <Box borderStyle="round" borderColor={ACCENT} paddingX={2} paddingY={1}>
        <Text color={ACCENT}>{spinner} </Text><Text>Scanning local coding-agent harnesses…</Text>
      </Box>
      <Footer>q quit</Footer>
    </Box>
  );
}

interface LineupViewProps {
  options: RacerOption[];
  selected: string[];
  cursor: number;
  columns?: number;
  rows?: number;
  notice?: string;
}

export function LineupView({ options, selected, cursor, columns = 80, rows = 24, notice }: LineupViewProps) {
  const optionMap = new Map(options.map((option) => [option.key, option]));
  const selectedOptions = selected.map((key) => optionMap.get(key)).filter((option): option is RacerOption => option !== undefined);
  const addIndex = selected.length < 6 ? selected.length : -1;
  const continueIndex = selected.length + (addIndex >= 0 ? 1 : 0);
  const spaciousRows = rows >= selectedOptions.length * 2 + 12;
  const horizontalPadding = columns < 64 ? 1 : 2;

  const item = (index: number, content: React.ReactNode, detail?: React.ReactNode, color?: string, spacious = false) => {
    const active = cursor === index;
    return (
      <Box
        key={index}
        height={spacious && spaciousRows ? 2 : 1}
        flexDirection="column"
        justifyContent="flex-start"
      >
        <Box height={1} paddingX={horizontalPadding} justifyContent="space-between" backgroundColor={active ? FOCUS_BACKGROUND : undefined}>
          <Box minWidth={0} flexGrow={1}>
            <Text bold={active} wrap="truncate-end">{active ? "› " : "  "}{color && <Text color={color}>● </Text>}{content}</Text>
          </Box>
          {detail && <Box marginLeft={1}><Text dimColor>{detail}</Text></Box>}
        </Box>
      </Box>
    );
  };

  return (
    <Box flexDirection="column" paddingY={spaciousRows ? 1 : 0} paddingX={horizontalPadding} width="100%">
      <Header phase="lineup" />
      <Box justifyContent="space-between">
        <Text bold>Build your lineup.</Text>
        <Text dimColor>{selected.length} / 6 racers</Text>
      </Box>
      <Text dimColor>Enter changes a racer; `a` adds one directly.</Text>

      <Box flexDirection="column" marginTop={spaciousRows ? 1 : 0}>
        <Box flexDirection="column">
          {selectedOptions.map((option, index) => item(
            index,
            <><Text dimColor>{String(index + 1).padStart(2, "0")} </Text>{option.model.label}</>,
            <>via {option.provider.name}</>,
            TUI_COLORS[index],
            true,
          ))}
        </Box>
        <Box flexDirection="column" marginTop={spaciousRows ? 1 : 0}>
          {addIndex >= 0 && item(addIndex, <>＋ Add racer</>, <>a</>)}
          {item(continueIndex, <>Continue to starting grid →</>, <>c</>)}
        </Box>
      </Box>

      {notice && <Text color={YELLOW}>{notice}</Text>}
      <Footer>{columns < 72
        ? "j/k move  enter change  a add  d remove  c continue"
        : "j/k move  enter change  a add  d remove  c continue  q quit"}</Footer>
    </Box>
  );
}

interface PickerViewProps {
  providers: ProviderInfo[];
  options: RacerOption[];
  filtered: RacerOption[];
  selected: string[];
  state: PickerState;
  columns: number;
  rows: number;
}

export function PickerView({ providers, options, filtered, selected, state, columns, rows }: PickerViewProps) {
  const activeProvider = providers[state.providerCursor];
  const narrow = columns < 64;
  const compactHeight = rows < 20;
  const paneGap = narrow ? 1 : 2;
  const panePaddingX = columns < 72 ? 1 : 2;
  const panePaddingY = compactHeight ? 0 : 1;
  const providerWidth = Math.max(15, Math.min(25, Math.floor(columns * (narrow ? 0.32 : 0.25))));
  const modelWidth = Math.max(20, columns - providerWidth - paneGap - 2);
  const paneHeight = Math.max(6, rows - 8);
  const visibleCount = Math.max(1, paneHeight - (panePaddingY * 2 + 5));
  const start = Math.max(0, Math.min(state.modelCursor - Math.floor(visibleCount / 2), filtered.length - visibleCount));
  const visible = filtered.slice(start, start + visibleCount);
  const providerVisibleCount = Math.max(1, paneHeight - (panePaddingY * 2 + 3 + (compactHeight ? 0 : 1)));
  const providerStart = Math.max(0, Math.min(state.providerCursor - Math.floor(providerVisibleCount / 2), providers.length - providerVisibleCount));
  const visibleProviders = providers.slice(providerStart, providerStart + providerVisibleCount);
  const labelWidth = Math.max(12, Math.min(34, Math.floor(modelWidth * 0.45)));

  return (
    <Box flexDirection="column" padding={1} width="100%">
      <Header phase="picker" />
      <Box justifyContent="space-between">
        <Text bold>{state.slot < selected.length ? `Change racer ${state.slot + 1}` : "Add a racer"}</Text>
        <Text dimColor>{state.focus === "providers" ? "harnesses" : state.searching ? "search" : "models"}</Text>
      </Box>
      <Box columnGap={paneGap} marginTop={1} height={paneHeight}>
        <Box
          width={providerWidth}
          height={paneHeight}
          borderStyle={state.focus === "providers" ? "double" : "round"}
          borderColor={MUTED}
          paddingX={panePaddingX}
          paddingY={panePaddingY}
          flexDirection="column"
          overflow="hidden"
        >
          <Box justifyContent="space-between" marginBottom={compactHeight ? 0 : 1}>
            <Text bold color={state.focus === "providers" ? ACCENT : undefined}>HARNESS</Text>
            {providers.length > providerVisibleCount && <Text dimColor>{providerStart + 1}–{Math.min(providerStart + providerVisibleCount, providers.length)}</Text>}
          </Box>
          <Box flexDirection="column">
            {visibleProviders.map((provider, visibleIndex) => {
              const index = providerStart + visibleIndex;
              const active = index === state.providerCursor;
              const count = options.filter((option) => option.provider.id === provider.id).length;
              return (
                <Box key={provider.id} height={1} overflow="hidden" justifyContent="space-between" paddingX={1}>
                  <Text bold={active} color={active ? ACCENT : undefined} wrap="truncate-end">{active ? "› " : "  "}{provider.name}</Text>
                  {columns >= 52 && <Text dimColor>{count}</Text>}
                </Box>
              );
            })}
          </Box>
        </Box>

        <Box
          width={modelWidth}
          height={paneHeight}
          borderStyle={state.focus === "models" ? "double" : "round"}
          borderColor={MUTED}
          paddingX={panePaddingX}
          paddingY={panePaddingY}
          flexDirection="column"
          overflow="hidden"
        >
          <Box justifyContent="space-between" marginBottom={compactHeight ? 0 : 1}>
            <Text color={state.searching ? ACCENT : undefined}>/ {state.query || "search models"}{state.searching ? "▌" : ""}</Text>
            <Text dimColor>{filtered.length ? `${start + 1}–${Math.min(start + visibleCount, filtered.length)} / ${filtered.length}` : "0 models"}</Text>
          </Box>
          <Box justifyContent="space-between">
            <Text bold>{activeProvider?.name ?? "Models"}</Text>
            <Text dimColor>{state.query ? `filter: ${state.query}` : "default first"}</Text>
          </Box>
          {visible.map((option, visibleIndex) => {
            const index = start + visibleIndex;
            const active = index === state.modelCursor;
            return (
              <Box key={option.key} height={1} overflow="hidden" paddingX={1}>
                <Box width={3}><Text color={active ? ACCENT : undefined}>{active ? "›" : " "}</Text></Box>
                <Box width={labelWidth}><Text bold={active} color={active ? ACCENT : undefined} wrap="truncate-end">{option.model.label}</Text></Box>
                <Box flexGrow={1}><Text dimColor wrap="truncate-end">{option.model.id}</Text></Box>
                {option.model.isDefault && <Text color={YELLOW}> DEFAULT</Text>}
              </Box>
            );
          })}
          {!filtered.length && <Box flexGrow={1} alignItems="center" justifyContent="center"><Text dimColor>No matching models</Text></Box>}
        </Box>
      </Box>
      <Footer>{state.searching
        ? columns < 72
          ? "type filter  ctrl+n/p browse  enter choose  esc done"
          : "type filter  ctrl+n/p browse  ctrl+u clear  enter choose  esc normal mode"
        : columns < 72
          ? "h/l tier  j/k browse  / search  enter choose  esc back"
          : "h/l tier  j/k browse  / search  g/G first/last  enter choose  q/esc back"}</Footer>
    </Box>
  );
}

interface SettingOptionProps {
  active: boolean;
  selected: boolean;
  width: number;
  label: string;
  detail: string;
  showDetail?: boolean;
}

function SettingOption({ active, selected, width, label, detail, showDetail = true }: SettingOptionProps) {
  return (
    <Box
      width={width}
      height={showDetail ? 2 : 1}
      paddingX={1}
      flexDirection="column"
      overflow="hidden"
      backgroundColor={selected ? FOCUS_BACKGROUND : active ? "#252536" : undefined}
    >
      <Text bold={active || selected} color={selected ? ACCENT : active ? BLUE : undefined}>{active ? "› " : "  "}{selected ? "● " : "○ "}{label}</Text>
      {showDetail && <Text dimColor wrap="truncate-end">{detail}</Text>}
    </Box>
  );
}

interface ConfigureViewProps {
  competitors: Competitor[];
  cursor: number;
  mode: RunMode;
  preset: SamplePreset;
  columns: number;
  rows?: number;
  notice?: string;
}

export function ConfigureView({ competitors, cursor, mode, preset, columns, rows = 24, notice }: ConfigureViewProps) {
  const compact = columns < 76 || rows < 19;
  const panelPaddingX = compact ? 1 : 2;
  const settingsWidth = Math.max(28, columns - 4 - panelPaddingX * 2);
  const labelWidth = 14;
  const runWidth = compact
    ? Math.max(10, Math.floor((settingsWidth - 1) / 2))
    : Math.max(20, Math.min(30, Math.floor((settingsWidth - labelWidth - 2) / 2)));
  const presetWidth = compact
    ? Math.max(8, Math.floor((settingsWidth - 2) / 3))
    : Math.max(17, Math.min(22, Math.floor((settingsWidth - labelWidth - 3) / 3)));
  return (
    <Box flexDirection="column" paddingY={compact ? 0 : 1} paddingX={1} width="100%">
      <Header phase="configure" />
      <Box justifyContent="space-between">
        <Text bold>Set the starting grid.</Text>
        <Text dimColor>e edit lineup</Text>
      </Box>
      <Box marginTop={compact ? 0 : 1} height={1} overflow="hidden">
        <Text wrap="truncate-end">
          {competitors.map((competitor, index) => (
            <React.Fragment key={competitor.id}>
              {index > 0 ? "  " : ""}<Text color={competitor.color}>● </Text><Text bold>{competitor.label}</Text>{!compact && <Text dimColor> · {competitor.harness}</Text>}
            </React.Fragment>
          ))}
        </Text>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderColor={MUTED} paddingX={panelPaddingX} paddingY={compact ? 0 : 1} marginTop={1}>
        {compact ? (
          <>
            <Text bold color={BLUE}>RUN ORDER</Text>
            <Box height={1} columnGap={1}>
              <SettingOption active={cursor === 0} selected={mode === "parallel"} width={runWidth} label="Parallel" detail="Start together" showDetail={false} />
              <SettingOption active={cursor === 1} selected={mode === "sequential"} width={runWidth} label="Sequential" detail="One at a time" showDetail={false} />
            </Box>
            <Box marginTop={1}><Text bold color={BLUE}>SAMPLES</Text></Box>
            <Box height={1} columnGap={1}>
              <SettingOption active={cursor === 2} selected={preset === "quick"} width={presetWidth} label="Quick" detail="2 measured" showDetail={false} />
              <SettingOption active={cursor === 3} selected={preset === "standard"} width={presetWidth} label="Standard" detail="2 warmup · 6 measured" showDetail={false} />
              <SettingOption active={cursor === 4} selected={preset === "thorough"} width={presetWidth} label="Thorough" detail="2 warmup · 10 measured" showDetail={false} />
            </Box>
          </>
        ) : (
          <>
            <Box height={2} columnGap={1} alignItems="flex-start">
              <Box width={labelWidth}><Text bold color={BLUE}>RUN ORDER</Text></Box>
              <SettingOption active={cursor === 0} selected={mode === "parallel"} width={runWidth} label="Parallel" detail="Start together" />
              <SettingOption active={cursor === 1} selected={mode === "sequential"} width={runWidth} label="Sequential" detail="One at a time" />
            </Box>

            <Box height={2} columnGap={1} marginTop={1} alignItems="flex-start">
              <Box width={labelWidth}><Text bold color={BLUE}>SAMPLES</Text></Box>
              <SettingOption active={cursor === 2} selected={preset === "quick"} width={presetWidth} label="Quick" detail="2 measured" />
              <SettingOption active={cursor === 3} selected={preset === "standard"} width={presetWidth} label="Standard" detail="2 warmup · 6 measured" />
              <SettingOption active={cursor === 4} selected={preset === "thorough"} width={presetWidth} label="Thorough" detail="2 warmup · 10 measured" />
            </Box>
          </>
        )}

        <Box marginTop={1} height={1} paddingX={1} justifyContent="space-between" backgroundColor={cursor === 5 ? "#313244" : undefined}>
          <Text bold color={cursor === 5 ? ACCENT : undefined}>{cursor === 5 ? "› " : "  "}Start race</Text>
          <Text dimColor>enter ↵</Text>
        </Box>
      </Box>
      {notice && <Text color={YELLOW}>{notice}</Text>}
      <Footer>{compact
        ? "h/j/k/l move  space select  enter start  e edit  q quit"
        : "h/j/k/l move  space select  enter start race  e/esc edit racers  q quit"}</Footer>
    </Box>
  );
}

function progressBar(done: number, total: number, width: number): string {
  const filled = total ? Math.round(Math.min(1, done / total) * width) : 0;
  return `${"━".repeat(filled)}${"─".repeat(Math.max(0, width - filled))}`;
}

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

interface RunningViewProps {
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
        <Text color={ACCENT}>{progressBar(race.completedRuns, race.totalRuns, barWidth)}</Text>
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

function ResultMetric({ width, value, best }: { width: number; value: string; best: boolean }) {
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
  if (row.finishRank === 3) return "#fab387";
  return undefined;
}

export function ResultsView({ race, columns, rows = 24 }: { race: TuiRaceState; columns: number; rows?: number }) {
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

function TuiApp() {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [phase, setPhase] = useState<Phase>("loading");
  const spinner = useSpinner(phase === "loading" || phase === "running");
  const pulse = usePulse(phase === "running");
  const [options, setOptions] = useState<RacerOption[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [lineupCursor, setLineupCursor] = useState(0);
  const [picker, setPicker] = useState<PickerState>({ slot: 0, providerCursor: 0, modelCursor: 0, focus: "models", query: "", searching: false });
  const [configCursor, setConfigCursor] = useState(0);
  const [mode, setMode] = useState<RunMode>("parallel");
  const [preset, setPreset] = useState<SamplePreset>("standard");
  const [race, setRace] = useState<TuiRaceState>(emptyRaceState);
  const [laneCursor, setLaneCursor] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const controller = useRef<AbortController | undefined>(undefined);

  const providers = useMemo(() => Array.from(new Map(options.map((option) => [option.provider.id, option.provider])).values()), [options]);
  const activeProvider = providers[picker.providerCursor];
  const filteredPickerOptions = useMemo(
    () => activeProvider ? filterRacerOptions(options, activeProvider.id, picker.query) : [],
    [activeProvider, options, picker.query],
  );
  const competitors = useMemo(() => competitorsFromSelection(options, selected), [options, selected]);
  const contentColumns = Math.max(1, Math.min(columns, 112));

  useEffect(() => {
    void getProviders()
      .then((providerInfo) => {
        const nextOptions = racerOptions(providerInfo);
        if (nextOptions.length < 2) throw new Error("CLI mode needs at least two available harness/model pairs.");
        setOptions(nextOptions);
        setSelected(defaultSelection(nextOptions));
        setPhase("lineup");
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason));
        setPhase("error");
      });
    return () => controller.current?.abort(new Error("Terminal closed."));
  }, []);

  useEffect(() => {
    const itemCount = selected.length + (selected.length < 6 ? 1 : 0) + 1;
    setLineupCursor((current) => Math.min(current, Math.max(0, itemCount - 1)));
  }, [selected.length]);

  useEffect(() => {
    setPicker((current) => ({
      ...current,
      modelCursor: Math.min(current.modelCursor, Math.max(0, filteredPickerOptions.length - 1)),
    }));
  }, [filteredPickerOptions.length]);

  const openPicker = useCallback((slot: number) => {
    const currentOption = options.find((option) => option.key === selected[slot]);
    const providerCursor = currentOption
      ? Math.max(0, providers.findIndex((provider) => provider.id === currentOption.provider.id))
      : 0;
    const provider = providers[providerCursor];
    const providerOptions = provider ? filterRacerOptions(options, provider.id, "") : [];
    const modelCursor = currentOption ? Math.max(0, providerOptions.findIndex((option) => option.key === currentOption.key)) : 0;
    setPicker({ slot, providerCursor, modelCursor, focus: "models", query: "", searching: false });
    setNotice(undefined);
    setPhase("picker");
  }, [options, providers, selected]);

  const choosePickerOption = useCallback(() => {
    const option = filteredPickerOptions[picker.modelCursor];
    if (!option) return;
    setSelected((current) => picker.slot < current.length
      ? current.map((keyValue, index) => index === picker.slot ? option.key : keyValue)
      : [...current, option.key]);
    setLineupCursor(picker.slot);
    setPhase("lineup");
  }, [filteredPickerOptions, picker.modelCursor, picker.slot]);

  const startRace = useCallback(() => {
    const abortController = new AbortController();
    controller.current = abortController;
    setRace(emptyRaceState());
    setLaneCursor(0);
    setZoomed(false);
    setNotice(undefined);
    setPhase("running");
    void runBenchmark(
      { type: "start", competitors, mode, samplePreset: preset },
      adapters,
      abortController.signal,
      (event) => setRace((current) => reduceRaceEvent(current, event)),
    )
      .then(() => setPhase("results"))
      .catch((reason) => {
        if (abortController.signal.aborted) {
          setNotice("Race cancelled.");
          setPhase("configure");
        } else {
          setRace((current) => ({ ...current, error: reason instanceof Error ? reason.message : String(reason) }));
          setPhase("results");
        }
      })
      .finally(() => {
        if (controller.current === abortController) controller.current = undefined;
      });
  }, [competitors, mode, preset]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      controller.current?.abort(new Error("Interrupted."));
      exit();
      return;
    }

    if (phase === "picker") {
      if (key.escape) {
        if (picker.searching) setPicker((current) => ({ ...current, searching: false }));
        else setPhase("lineup");
        return;
      }
      if (picker.searching) {
        if (key.upArrow || (key.ctrl && input === "p")) {
          setPicker((current) => ({ ...current, modelCursor: (current.modelCursor - 1 + Math.max(1, filteredPickerOptions.length)) % Math.max(1, filteredPickerOptions.length) }));
          return;
        }
        if (key.downArrow || (key.ctrl && input === "n")) {
          setPicker((current) => ({ ...current, modelCursor: (current.modelCursor + 1) % Math.max(1, filteredPickerOptions.length) }));
          return;
        }
        if (key.backspace || key.delete) {
          setPicker((current) => ({ ...current, query: current.query.slice(0, -1), modelCursor: 0 }));
          return;
        }
        if (key.ctrl && input === "u") {
          setPicker((current) => ({ ...current, query: "", modelCursor: 0 }));
          return;
        }
        if (key.return) {
          choosePickerOption();
          return;
        }
        if (input && !key.ctrl && !key.meta && !key.tab) {
          setPicker((current) => ({ ...current, query: current.query + input, modelCursor: 0 }));
        }
        return;
      }
      if (input === "q") {
        setPhase("lineup");
        return;
      }
      if (input === "/") {
        setPicker((current) => ({ ...current, focus: "models", searching: true }));
        return;
      }
      if (input === "c") {
        setPicker((current) => ({ ...current, query: "", modelCursor: 0 }));
        return;
      }
      if (key.tab) {
        setPicker((current) => ({ ...current, focus: current.focus === "providers" ? "models" : "providers" }));
        return;
      }
      if (picker.focus === "providers") {
        if (key.upArrow || input === "k") {
          setPicker((current) => ({ ...current, providerCursor: (current.providerCursor - 1 + providers.length) % providers.length, modelCursor: 0, query: "", searching: false }));
          return;
        }
        if (key.downArrow || input === "j") {
          setPicker((current) => ({ ...current, providerCursor: (current.providerCursor + 1) % providers.length, modelCursor: 0, query: "", searching: false }));
          return;
        }
        if (key.home || input === "g") {
          setPicker((current) => ({ ...current, providerCursor: 0, modelCursor: 0, query: "" }));
          return;
        }
        if (key.end || input === "G") {
          setPicker((current) => ({ ...current, providerCursor: Math.max(0, providers.length - 1), modelCursor: 0, query: "" }));
          return;
        }
        if (key.rightArrow || input === "l" || key.return) {
          setPicker((current) => ({ ...current, focus: "models" }));
          return;
        }
      } else {
        if (key.leftArrow || input === "h") {
          setPicker((current) => ({ ...current, focus: "providers" }));
          return;
        }
        if (key.upArrow || input === "k") {
          setPicker((current) => ({ ...current, modelCursor: (current.modelCursor - 1 + Math.max(1, filteredPickerOptions.length)) % Math.max(1, filteredPickerOptions.length) }));
          return;
        }
        if (key.downArrow || input === "j") {
          setPicker((current) => ({ ...current, modelCursor: (current.modelCursor + 1) % Math.max(1, filteredPickerOptions.length) }));
          return;
        }
        if (key.home || input === "g") {
          setPicker((current) => ({ ...current, modelCursor: 0 }));
          return;
        }
        if (key.end || input === "G") {
          setPicker((current) => ({ ...current, modelCursor: Math.max(0, filteredPickerOptions.length - 1) }));
          return;
        }
        if (key.pageUp || key.pageDown) {
          const direction = key.pageUp ? -1 : 1;
          setPicker((current) => ({ ...current, modelCursor: Math.max(0, Math.min(filteredPickerOptions.length - 1, current.modelCursor + direction * 8)) }));
          return;
        }
        if (key.return) {
          choosePickerOption();
          return;
        }
      }
      return;
    }

    if (input === "q" && phase !== "running") {
      exit();
      return;
    }
    if (phase === "error") {
      if (key.return || key.escape) exit();
      return;
    }
    if (phase === "lineup") {
      const addIndex = selected.length < 6 ? selected.length : -1;
      const continueIndex = selected.length + (addIndex >= 0 ? 1 : 0);
      const itemCount = continueIndex + 1;
      if (input === "a") {
        if (selected.length < 6) openPicker(selected.length);
        else setNotice("A race supports at most six racers.");
        return;
      }
      if (key.leftArrow || input === "h") setLineupCursor((value) => (value - 1 + itemCount) % itemCount);
      if (key.rightArrow || input === "l") setLineupCursor((value) => (value + 1) % itemCount);
      if (key.upArrow || input === "k") setLineupCursor((value) => Math.max(0, value - 1));
      if (key.downArrow || input === "j") setLineupCursor((value) => Math.min(itemCount - 1, value + 1));
      if (input === "g") setLineupCursor(0);
      if (input === "G") setLineupCursor(itemCount - 1);
      if (input === "d" && lineupCursor < selected.length) {
        setSelected((current) => current.filter((_, index) => index !== lineupCursor));
        setNotice(undefined);
      }
      if (input === "c") {
        if (selected.length >= 2) {
          setNotice(undefined);
          setPhase("configure");
        } else setNotice("Add at least two racers.");
      }
      if (key.return) {
        if (lineupCursor < selected.length) openPicker(lineupCursor);
        else if (lineupCursor === addIndex) openPicker(selected.length);
        else if (lineupCursor === continueIndex) {
          if (selected.length >= 2) {
            setNotice(undefined);
            setPhase("configure");
          } else setNotice("Add at least two racers.");
        }
      }
      return;
    }
    if (phase === "configure") {
      if (key.escape || input === "e") {
        setPhase("lineup");
        return;
      }
      if (key.upArrow || input === "k") {
        setConfigCursor((current) => current === 5 ? 2 + ["quick", "standard", "thorough"].indexOf(preset) : current >= 2 ? (mode === "parallel" ? 0 : 1) : current);
        return;
      }
      if (key.downArrow || input === "j") {
        setConfigCursor((current) => current <= 1 ? 2 + ["quick", "standard", "thorough"].indexOf(preset) : current <= 4 ? 5 : current);
        return;
      }
      if (key.leftArrow || key.rightArrow || input === "h" || input === "l") {
        if (configCursor <= 1) {
          const next = key.leftArrow || input === "h" ? 0 : 1;
          setConfigCursor(next);
          setMode(next === 0 ? "parallel" : "sequential");
        } else if (configCursor <= 4) {
          const currentPreset = configCursor - 2;
          const nextPreset = (currentPreset + (key.leftArrow || input === "h" ? 2 : 1)) % 3;
          const values: SamplePreset[] = ["quick", "standard", "thorough"];
          setConfigCursor(nextPreset + 2);
          setPreset(values[nextPreset]);
        }
        return;
      }
      if (input === "g") {
        setConfigCursor(0);
        return;
      }
      if (input === "G") {
        setConfigCursor(5);
        return;
      }
      if (key.return || input === " ") {
        const activation = configureActivation(configCursor, key.return ? "enter" : "space");
        if (activation?.type === "start") startRace();
        else if (activation?.type === "mode") setMode(activation.value);
        else if (activation?.type === "preset") setPreset(activation.value);
        return;
      }
      return;
    }
    if (phase === "running") {
      const gridColumns = raceGridColumns(columns, competitors.length);
      if (key.leftArrow || input === "h") setLaneCursor((current) => Math.max(0, current - 1));
      if (key.rightArrow || input === "l") setLaneCursor((current) => Math.min(competitors.length - 1, current + 1));
      if (key.upArrow || input === "k") setLaneCursor((current) => Math.max(0, current - gridColumns));
      if (key.downArrow || input === "j") setLaneCursor((current) => Math.min(competitors.length - 1, current + gridColumns));
      if (input === "g") setLaneCursor(0);
      if (input === "G") setLaneCursor(competitors.length - 1);
      if (/^[1-6]$/.test(input)) setLaneCursor(Math.min(competitors.length - 1, Number(input) - 1));
      if (key.return || input === "z") setZoomed((current) => !current);
      if (key.escape) {
        if (zoomed) setZoomed(false);
        else controller.current?.abort(new Error("Race cancelled."));
      }
      return;
    }
    if (phase === "results") {
      if (input === "r") setPhase("configure");
      else if (key.return || input === "q") exit();
    }
  });

  let view: React.ReactNode;
  if (phase === "loading") view = <LoadingView spinner={spinner} />;
  else if (phase === "error") view = <Box flexDirection="column" padding={1} width="100%"><Header phase="error" /><Text bold color="red">Could not start terminal mode.</Text><Text>{error}</Text><Footer>enter/q quit</Footer></Box>;
  else if (phase === "lineup") view = <LineupView options={options} selected={selected} cursor={lineupCursor} columns={contentColumns} rows={rows} notice={notice} />;
  else if (phase === "picker") view = <PickerView providers={providers} options={options} filtered={filteredPickerOptions} selected={selected} state={picker} columns={contentColumns} rows={rows} />;
  else if (phase === "configure") view = <ConfigureView competitors={competitors} cursor={configCursor} mode={mode} preset={preset} columns={contentColumns} rows={rows} notice={notice} />;
  else if (phase === "running") return <RunningView competitors={competitors} race={race} spinner={spinner} columns={columns} rows={rows} cursor={laneCursor} zoomed={zoomed} pulse={pulse} />;
  else view = <ResultsView race={race} columns={contentColumns} rows={rows} />;

  return (
    <Box key={`${phase}:${columns}x${rows}`} width={columns} height={rows} overflow="hidden" justifyContent="center">
      <Box width={contentColumns} height={rows} overflow="hidden">{view}</Box>
    </Box>
  );
}

export async function runTui(): Promise<void> {
  const instance = render(<TuiApp />, {
    exitOnCtrlC: false,
    incrementalRendering: true,
    maxFps: 20,
  });
  await instance.waitUntilExit();
}
