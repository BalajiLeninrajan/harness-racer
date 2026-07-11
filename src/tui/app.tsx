/** @jsxImportSource @opentui/react */
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { HarnessAdapter } from "../server/adapters/types.js";
import type { Competitor } from "../shared/types.js";
import type { BenchmarkRunner, TerminalModeResult } from "../terminal.js";
import { CommandPalette, filterCommands, type WorkspaceCommand } from "./components/command-palette.js";
import { Inspector } from "./components/inspector.js";
import { Leaderboard } from "./components/leaderboard.js";
import { RaceGrid } from "./components/race-grid.js";
import { Roster } from "./components/roster.js";
import { ActionDock, WorkspaceHeader } from "./components/workspace-chrome.js";
import {
  categorizeProbes,
  createBenchmarkRequest,
  createCompetitors,
  createStackOptions,
  defaultStackSelection,
  type BenchmarkSettings,
} from "./domain/competitors.js";
import { resolveWorkspaceLayout } from "./domain/layout.js";
import { classificationEntries } from "./domain/results.js";
import { useBenchmark } from "./hooks/use-benchmark.js";
import { useProbe, type ProbeAdapters } from "./hooks/use-probe.js";
import { palette } from "./palette.js";

type FocusArea = "roster" | "lanes" | "results";
type OverlayPanel = "none" | "roster" | "inspector";

export interface TpsRacerAppProps {
  adapters: readonly HarnessAdapter[];
  runBenchmark: BenchmarkRunner;
  probeAdapters: ProbeAdapters;
  signal?: AbortSignal;
  onExit: (result: TerminalModeResult) => void;
  onShutdownReady?: (shutdown: () => Promise<void>) => void;
}

function nextPreset(current: BenchmarkSettings["samplePreset"]): BenchmarkSettings["samplePreset"] {
  return current === "quick" ? "standard" : current === "standard" ? "thorough" : "quick";
}

function emptyMessage(loading: boolean, hasStacks: boolean, hasSelection: boolean): {
  title: string;
  body: string;
  color: string;
} | undefined {
  if (loading) return {
    title: "Discovering local CLIs",
    body: "Checking installed harnesses and model catalogs…",
    color: palette.cyan,
  };
  if (!hasStacks) return {
    title: "No runnable harnesses",
    body: "Install and authenticate at least one supported CLI, then rescan from the command palette.",
    color: palette.red,
  };
  if (!hasSelection) return {
    title: "The grid is empty",
    body: "Select a model from the racer roster. One model creates a head-to-head mirror race.",
    color: palette.yellow,
  };
  return undefined;
}

export function TpsRacerApp({
  adapters,
  runBenchmark,
  probeAdapters,
  signal,
  onExit,
  onShutdownReady,
}: TpsRacerAppProps) {
  const dimensions = useTerminalDimensions();
  const layout = resolveWorkspaceLayout(dimensions.width);
  const probe = useProbe({ adapters, probe: probeAdapters });
  const catalog = useMemo(() => categorizeProbes(probe.results), [probe.results]);
  const stacks = useMemo(() => createStackOptions(catalog.runnable), [catalog.runnable]);
  const benchmark = useBenchmark({ runner: runBenchmark, runnable: catalog.runnable });

  useEffect(() => {
    onShutdownReady?.(benchmark.shutdown);
  }, [benchmark.shutdown, onShutdownReady]);

  const [selectionOverride, setSelectionOverride] = useState<string[]>();
  const [raceCompetitors, setRaceCompetitors] = useState<Competitor[]>([]);
  const [rosterCursor, setRosterCursor] = useState(0);
  const [focusedLane, setFocusedLane] = useState(0);
  const [resultCursor, setResultCursor] = useState(0);
  const [focusArea, setFocusArea] = useState<FocusArea>("roster");
  const [overlay, setOverlay] = useState<OverlayPanel>(() => layout.showRoster ? "none" : "roster");
  const [settings, setSettings] = useState<BenchmarkSettings>({
    mode: "parallel",
    samplePreset: "standard",
  });
  const [raceSettings, setRaceSettings] = useState<BenchmarkSettings>(settings);
  const [notice, setNotice] = useState<string>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteCursor, setPaletteCursor] = useState(0);

  const selectedValues = useMemo(
    () => selectionOverride ?? (probe.loading ? [] : defaultStackSelection(catalog.runnable)),
    [catalog.runnable, probe.loading, selectionOverride],
  );

  useEffect(() => {
    setRosterCursor((current) => Math.max(0, Math.min(current, stacks.length - 1)));
  }, [stacks.length]);

  useEffect(() => {
    setPaletteCursor(0);
  }, [paletteQuery]);

  useEffect(() => {
    if (!signal) return;
    const cancel = () => {
      void benchmark.shutdown().then(() => onExit("cancelled"));
    };
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
    return () => signal.removeEventListener("abort", cancel);
  }, [benchmark.shutdown, onExit, signal]);

  const configuredCompetitors = useMemo(() => {
    try {
      return createCompetitors(selectedValues, stacks);
    } catch {
      return [];
    }
  }, [selectedValues, stacks]);

  const displayCompetitors = raceCompetitors.length && benchmark.state.phase !== "idle"
    ? raceCompetitors
    : configuredCompetitors;
  const displaySettings = raceCompetitors.length && benchmark.state.phase !== "idle"
    ? raceSettings
    : settings;
  const phaseRef = useRef(benchmark.state.phase);
  const competitorCountRef = useRef(displayCompetitors.length);
  const activeRef = useRef(benchmark.active);
  const focusAreaRef = useRef(focusArea);
  const rosterCursorRef = useRef(rosterCursor);
  const resultCursorRef = useRef(resultCursor);
  const selectedValuesRef = useRef(selectedValues);
  const settingsRef = useRef(settings);
  const stacksRef = useRef(stacks);
  const raceCompetitorsRef = useRef(raceCompetitors);
  phaseRef.current = benchmark.state.phase;
  competitorCountRef.current = displayCompetitors.length;
  activeRef.current = benchmark.active;
  focusAreaRef.current = focusArea;
  rosterCursorRef.current = rosterCursor;
  resultCursorRef.current = resultCursor;
  selectedValuesRef.current = selectedValues;
  settingsRef.current = settings;
  stacksRef.current = stacks;
  raceCompetitorsRef.current = raceCompetitors;

  useEffect(() => {
    setFocusedLane((current) => Math.max(0, Math.min(current, displayCompetitors.length - 1)));
    setResultCursor((current) => {
      const next = Math.max(0, Math.min(current, displayCompetitors.length - 1));
      resultCursorRef.current = next;
      return next;
    });
  }, [displayCompetitors.length]);

  useEffect(() => {
    if (benchmark.state.phase === "complete") setFocusArea("results");
  }, [benchmark.state.phase]);

  const toggleSelection = useCallback((value: string) => {
    if (activeRef.current) return;
    const current = selectedValuesRef.current;
    if (current.includes(value)) {
      setNotice(undefined);
      const next = current.filter((item) => item !== value);
      selectedValuesRef.current = next;
      setSelectionOverride(next);
      return;
    }
    if (current.length >= 6) {
      setNotice("The live grid supports up to six racers.");
      return;
    }
    setNotice(undefined);
    const next = [...current, value];
    selectedValuesRef.current = next;
    setSelectionOverride(next);
  }, []);

  const cancelRace = useCallback(() => {
    activeRef.current = false;
    void benchmark.cancel();
  }, [benchmark.cancel]);

  const launchRace = useCallback((competitors: readonly Competitor[]) => {
    if (activeRef.current) return;
    if (competitors.length < 2) {
      setNotice("Select at least one model to create a race.");
      setFocusArea("roster");
      setOverlay("roster");
      return;
    }
    const next = competitors.map((competitor) => ({ ...competitor }));
    const runSettings = settingsRef.current;
    setNotice(undefined);
    raceCompetitorsRef.current = next;
    setRaceCompetitors(next);
    setRaceSettings({ ...runSettings });
    setFocusedLane(0);
    resultCursorRef.current = 0;
    setResultCursor(0);
    setFocusArea("lanes");
    setOverlay("none");
    activeRef.current = true;
    benchmark.start(createBenchmarkRequest(next, runSettings));
  }, [benchmark.start]);

  const configuredFromRefs = useCallback((): Competitor[] => {
    try {
      return createCompetitors(selectedValuesRef.current, stacksRef.current);
    } catch {
      return [];
    }
  }, []);

  const startRace = useCallback(() => launchRace(configuredFromRefs()), [configuredFromRefs, launchRace]);
  const rerunRace = useCallback(() => {
    launchRace(raceCompetitorsRef.current.length ? raceCompetitorsRef.current : configuredFromRefs());
  }, [configuredFromRefs, launchRace]);

  const editGrid = useCallback(() => {
    const competitors = configuredFromRefs();
    benchmark.reset(competitors);
    raceCompetitorsRef.current = [];
    setRaceCompetitors([]);
    setFocusArea("roster");
    setOverlay(layout.showRoster ? "none" : "roster");
  }, [benchmark.reset, configuredFromRefs, layout.showRoster]);

  const focusRoster = useCallback(() => {
    setFocusArea("roster");
    if (!layout.showRoster) setOverlay("roster");
  }, [layout.showRoster]);

  const cycleMode = useCallback(() => {
    if (activeRef.current) return;
    const current = settingsRef.current;
    const next: BenchmarkSettings = {
      ...current,
      mode: current.mode === "parallel" ? "sequential" : "parallel",
    };
    settingsRef.current = next;
    setSettings(next);
  }, []);

  const cyclePreset = useCallback(() => {
    if (activeRef.current) return;
    const current = settingsRef.current;
    const next: BenchmarkSettings = {
      ...current,
      samplePreset: nextPreset(current.samplePreset),
    };
    settingsRef.current = next;
    setSettings(next);
  }, []);

  const moveResultCursor = useCallback((delta: number) => {
    const count = competitorCountRef.current;
    const next = count ? (resultCursorRef.current + delta + count) % count : 0;
    resultCursorRef.current = next;
    setResultCursor(next);
  }, []);

  const focusNextLane = useCallback(() => {
    if (!displayCompetitors.length) return;
    if (benchmark.state.phase === "complete") {
      setFocusArea("results");
      moveResultCursor(1);
    } else {
      setFocusArea("lanes");
      setFocusedLane((current) => (current + 1) % displayCompetitors.length);
    }
    setOverlay("none");
  }, [benchmark.state.phase, displayCompetitors.length, moveResultCursor]);

  const dismissPanel = useCallback(() => {
    setOverlay("none");
    if (!layout.showRoster && focusArea === "roster") {
      setFocusArea(benchmark.state.phase === "complete" ? "results" : "lanes");
    }
  }, [benchmark.state.phase, focusArea, layout.showRoster]);

  useEffect(() => {
    if (!layout.showRoster && overlay !== "roster" && focusArea === "roster") {
      setFocusArea(benchmark.state.phase === "complete" ? "results" : "lanes");
    }
  }, [benchmark.state.phase, focusArea, layout.showRoster, overlay]);

  const openCommands = useCallback(() => {
    setPaletteQuery("");
    setPaletteCursor(0);
    setPaletteOpen(true);
  }, []);

  const closeCommands = useCallback(() => setPaletteOpen(false), []);

  const commands = useMemo<WorkspaceCommand[]>(() => {
    const items: WorkspaceCommand[] = [];
    if (benchmark.active) {
      items.push({
        id: "race.stop",
        title: "Stop the current race",
        description: "Cancel all active harness processes",
        shortcut: "ctrl+c",
        category: "Race",
        run: cancelRace,
      });
    } else {
      items.push({
        id: "race.start",
        title: benchmark.state.phase !== "idle" ? "Race again" : "Start race",
        description: `${configuredCompetitors.length} lanes · ${settings.mode} · ${settings.samplePreset}`,
        shortcut: benchmark.state.phase !== "idle" ? "r" : "enter",
        category: "Race",
        run: benchmark.state.phase !== "idle" ? rerunRace : startRace,
      });
    }
    items.push({
        id: "grid.edit",
        title: "Edit starting grid",
        description: "Focus the model roster without leaving the workspace",
        shortcut: "s",
        category: "Grid",
        run: editGrid,
      });
    if (!benchmark.active) {
      items.push({
        id: "grid.mode",
        title: `Run mode: ${settings.mode}`,
        description: "Switch between a parallel start and sequential time trial",
        shortcut: "m",
        category: "Grid",
        run: cycleMode,
      }, {
        id: "grid.preset",
        title: `Sample preset: ${settings.samplePreset}`,
        description: "Cycle quick, standard, and thorough samples",
        shortcut: "p",
        category: "Grid",
        run: cyclePreset,
      });
    }
    items.push(
      {
        id: "view.next",
        title: "Focus next racer pane",
        description: "Move scroll ownership without resizing the grid",
        shortcut: "tab",
        category: "View",
        run: focusNextLane,
      },
      {
        id: "view.inspector",
        title: "Show race inspector",
        description: "Open standings and focused-pane metrics",
        shortcut: "i",
        category: "View",
        run: () => setOverlay("inspector"),
      },
      {
        id: "application.rescan",
        title: "Rescan local CLIs",
        description: "Refresh installed harnesses and model catalogs",
        category: "Application",
        run: probe.retry,
      },
    );
    if (!benchmark.active) {
      items.push({
        id: "application.quit",
        title: "Quit TPS Racer",
        shortcut: "q",
        category: "Application",
        run: () => {
          if (activeRef.current) {
            cancelRace();
            return;
          }
          onExit(phaseRef.current === "complete" ? "completed" : "declined");
        },
      });
    }
    return items;
  }, [
    benchmark.active,
    benchmark.state.phase,
    cancelRace,
    configuredCompetitors.length,
    cycleMode,
    cyclePreset,
    editGrid,
    focusNextLane,
    onExit,
    probe.retry,
    rerunRace,
    settings.mode,
    settings.samplePreset,
    startRace,
  ]);

  useKeyboard((key) => {
    if (key.eventType === "release") return;
    // OpenTUI exposes printable keys as `name` under Kitty keyboard mode and
    // as the raw one-character `sequence` in simpler terminals and tests.
    const keyName = key.name || key.sequence;

    if (key.ctrl && keyName === "c") {
      key.preventDefault();
      closeCommands();
      if (activeRef.current) cancelRace();
      else onExit("cancelled");
      return;
    }

    if (paletteOpen) {
      const count = filterCommands(commands, paletteQuery).length;
      if (keyName === "escape") {
        key.preventDefault();
        closeCommands();
      } else if (keyName === "up" || (key.ctrl && keyName === "p")) {
        key.preventDefault();
        setPaletteCursor((current) => count ? (current - 1 + count) % count : 0);
      } else if (keyName === "down" || (key.ctrl && keyName === "n")) {
        key.preventDefault();
        setPaletteCursor((current) => count ? (current + 1) % count : 0);
      } else if (keyName === "home") {
        key.preventDefault();
        setPaletteCursor(0);
      } else if (keyName === "end") {
        key.preventDefault();
        setPaletteCursor(Math.max(0, count - 1));
      } else if (keyName === "pageup" || keyName === "pagedown") {
        key.preventDefault();
        const direction = keyName === "pageup" ? -10 : 10;
        setPaletteCursor((current) => count
          ? Math.max(0, Math.min(count - 1, current + direction))
          : 0);
      }
      return;
    }

    if (key.ctrl && keyName === "p") {
      key.preventDefault();
      openCommands();
      return;
    }
    if (keyName === "q") {
      key.preventDefault();
      if (activeRef.current) cancelRace();
      else onExit(benchmark.state.phase === "complete" ? "completed" : "declined");
      return;
    }
    if (keyName === "escape") {
      if (overlay !== "none") {
        key.preventDefault();
        dismissPanel();
      }
      return;
    }
    if (keyName === "s") {
      key.preventDefault();
      focusRoster();
      return;
    }
    if (keyName === "i") {
      key.preventDefault();
      setOverlay((current) => current === "inspector" ? "none" : "inspector");
      return;
    }
    if (keyName === "m" && !activeRef.current) {
      key.preventDefault();
      cycleMode();
      return;
    }
    if (keyName === "p" && !activeRef.current) {
      key.preventDefault();
      cyclePreset();
      return;
    }
    if (keyName === "r" && !activeRef.current && phaseRef.current !== "idle") {
      key.preventDefault();
      rerunRace();
      return;
    }
    if ((keyName === "return" || keyName === "kpenter") && !activeRef.current) {
      key.preventDefault();
      startRace();
      return;
    }
    if (keyName === "tab") {
      key.preventDefault();
      if (!displayCompetitors.length) return;
      setOverlay("none");
      if (benchmark.state.phase === "complete") {
        setFocusArea("results");
        moveResultCursor(key.shift ? -1 : 1);
      } else {
        setFocusArea("lanes");
        setFocusedLane((current) => (
          current + (key.shift ? -1 : 1) + displayCompetitors.length
        ) % displayCompetitors.length);
      }
      return;
    }

    // Completed races always give vertical navigation to the leaderboard,
    // even if a focus transition from the just-closed roster is still
    // committing in the same frame.
    if (phaseRef.current === "complete" && (keyName === "up" || keyName === "down")) {
      key.preventDefault();
      setFocusArea("results");
      moveResultCursor(keyName === "up" ? -1 : 1);
      return;
    }

    if (focusAreaRef.current === "roster") {
      if (keyName === "up") {
        key.preventDefault();
        setRosterCursor((current) => {
          const count = stacksRef.current.length;
          const next = count ? (current - 1 + count) % count : 0;
          rosterCursorRef.current = next;
          return next;
        });
      } else if (keyName === "down") {
        key.preventDefault();
        setRosterCursor((current) => {
          const count = stacksRef.current.length;
          const next = count ? (current + 1) % count : 0;
          rosterCursorRef.current = next;
          return next;
        });
      } else if (keyName === "space" || keyName === " ") {
        key.preventDefault();
        const stack = stacksRef.current[rosterCursorRef.current];
        if (stack) toggleSelection(stack.value);
      }
      return;
    }

    if (focusArea === "results") {
      if (keyName === "up") {
        key.preventDefault();
        setFocusArea("results");
        moveResultCursor(-1);
      } else if (keyName === "down") {
        key.preventDefault();
        setFocusArea("results");
        moveResultCursor(1);
      }
    }
  });

  const empty = emptyMessage(probe.loading, Boolean(stacks.length), Boolean(displayCompetitors.length));
  const showRoster = layout.showRoster;
  const showInspector = layout.showInspector;
  const mainWidth = layout.mainWidth;
  const resultCompetitor = benchmark.state.phase === "complete"
    ? classificationEntries(displayCompetitors, benchmark.state)[resultCursor]?.competitor
    : undefined;

  const roster = (
    <Roster
      stacks={stacks}
      unavailable={catalog.unavailable}
      selected={new Set(selectedValues)}
      cursor={rosterCursor}
      focused={focusArea === "roster"}
      settings={settings}
      loading={probe.loading}
      onFocus={() => setFocusArea("roster")}
      onCursor={setRosterCursor}
      onToggle={toggleSelection}
      onCycleMode={() => {
        cycleMode();
      }}
      onCyclePreset={() => {
        cyclePreset();
      }}
    />
  );

  const inspector = (
    <Inspector
      competitors={displayCompetitors}
      state={benchmark.state}
      settings={displaySettings}
      focusedId={resultCompetitor?.id ?? displayCompetitors[focusedLane]?.id}
    />
  );

  return (
    <box
      width={dimensions.width}
      height={dimensions.height}
      flexDirection="row"
      backgroundColor={palette.canvas}
    >
      {showRoster ? roster : null}

      <box flexGrow={1} minWidth={0} height="100%" flexDirection="column" backgroundColor={palette.canvas}>
        <WorkspaceHeader
          phase={benchmark.state.phase}
          settings={displaySettings}
          racerCount={displayCompetitors.length}
          completedRuns={benchmark.state.completedRuns}
          totalRuns={benchmark.state.totalRuns}
        />

        <box flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1} paddingBottom={1}>
          {empty ? (
            <box flexGrow={1} alignItems="center" justifyContent="center" flexDirection="column">
              <text fg={empty.color}>● {empty.title}</text>
              <text fg={palette.textMuted}>{empty.body}</text>
            </box>
          ) : benchmark.state.phase === "complete" ? (
            <Leaderboard
              competitors={displayCompetitors}
              state={benchmark.state}
              settings={displaySettings}
              selectedIndex={resultCursor}
              width={mainWidth - 2}
              height={Math.max(1, dimensions.height - 8)}
              focused={focusArea === "results"}
              onSelect={(index) => {
                resultCursorRef.current = index;
                setResultCursor(index);
                setFocusArea("results");
              }}
            />
          ) : (
            <RaceGrid
              competitors={displayCompetitors}
              state={benchmark.state}
              settings={displaySettings}
              width={mainWidth - 2}
              focusedIndex={focusedLane}
              onFocus={(index) => {
                setFocusedLane(index);
                setFocusArea("lanes");
                setOverlay("none");
              }}
            />
          )}
        </box>

        <ActionDock
          phase={benchmark.state.phase}
          selectedCount={selectedValues.length}
          active={benchmark.active}
          notice={notice ?? benchmark.state.notice}
          onPrimary={benchmark.active
            ? cancelRace
            : benchmark.state.phase !== "idle"
              ? rerunRace
              : startRace}
          onCommands={openCommands}
        />
      </box>

      {showInspector ? inspector : null}

      {!showRoster && overlay === "roster" ? (
        <box
          position="absolute"
          left={0}
          top={0}
          zIndex={500}
          width={dimensions.width}
          height={dimensions.height}
          backgroundColor="#000000aa"
          onMouseUp={dismissPanel}
        >
          <box onMouseUp={(event) => event.stopPropagation()}>{roster}</box>
        </box>
      ) : null}

      {!showInspector && overlay === "inspector" ? (
        <box
          position="absolute"
          left={0}
          top={0}
          zIndex={500}
          width={dimensions.width}
          height={dimensions.height}
          alignItems="flex-end"
          backgroundColor="#000000aa"
          onMouseUp={dismissPanel}
        >
          <box onMouseUp={(event) => event.stopPropagation()}>{inspector}</box>
        </box>
      ) : null}

      {paletteOpen ? (
        <CommandPalette
          width={dimensions.width}
          height={dimensions.height}
          query={paletteQuery}
          commands={commands}
          selectedIndex={paletteCursor}
          onQuery={setPaletteQuery}
          onSelectedIndex={setPaletteCursor}
          onRun={(command) => {
            closeCommands();
            command.run();
          }}
          onClose={closeCommands}
        />
      ) : null}
    </box>
  );
}
