import type { Key } from "ink";
import type { RunMode, SamplePreset } from "../../shared/types.js";
import { MAX_RACERS, SAMPLE_PRESETS } from "../constants.js";
import { configureActivation, raceGridColumns } from "../model.js";

export type LineupInputCommand =
  | { type: "none" }
  | { type: "cursor"; cursor: number }
  | { type: "open-picker"; slot: number }
  | { type: "remove"; index: number }
  | { type: "continue" }
  | { type: "notice"; message: string };

export function resolveLineupInput(
  selectedCount: number,
  cursor: number,
  input: string,
  key: Key,
): LineupInputCommand {
  const addIndex = selectedCount < MAX_RACERS ? selectedCount : -1;
  const continueIndex = selectedCount + (addIndex >= 0 ? 1 : 0);
  const itemCount = continueIndex + 1;

  if (input === "a") {
    return selectedCount < MAX_RACERS
      ? { type: "open-picker", slot: selectedCount }
      : { type: "notice", message: "A race supports at most six racers." };
  }
  if (key.leftArrow || input === "h") return { type: "cursor", cursor: (cursor - 1 + itemCount) % itemCount };
  if (key.rightArrow || input === "l") return { type: "cursor", cursor: (cursor + 1) % itemCount };
  if (key.upArrow || input === "k") return { type: "cursor", cursor: Math.max(0, cursor - 1) };
  if (key.downArrow || input === "j") return { type: "cursor", cursor: Math.min(itemCount - 1, cursor + 1) };
  if (input === "g") return { type: "cursor", cursor: 0 };
  if (input === "G") return { type: "cursor", cursor: itemCount - 1 };
  if (input === "d" && cursor < selectedCount) return { type: "remove", index: cursor };
  if (input === "c") return { type: "continue" };
  if (key.return) {
    if (cursor < selectedCount) return { type: "open-picker", slot: cursor };
    if (cursor === addIndex) return { type: "open-picker", slot: selectedCount };
    if (cursor === continueIndex) return { type: "continue" };
  }
  return { type: "none" };
}

interface ConfigureInputState {
  cursor: number;
  mode: RunMode;
  preset: SamplePreset;
}

export type ConfigureInputCommand =
  | { type: "none" }
  | { type: "back" }
  | { type: "start" }
  | { type: "update"; state: ConfigureInputState };

export function resolveConfigureInput(
  state: ConfigureInputState,
  input: string,
  key: Key,
): ConfigureInputCommand {
  if (key.escape || input === "e") return { type: "back" };
  if (key.upArrow || input === "k") {
    const cursor = state.cursor === 5
      ? 2 + SAMPLE_PRESETS.indexOf(state.preset)
      : state.cursor >= 2
        ? state.mode === "parallel" ? 0 : 1
        : state.cursor;
    return { type: "update", state: { ...state, cursor } };
  }
  if (key.downArrow || input === "j") {
    const cursor = state.cursor <= 1
      ? 2 + SAMPLE_PRESETS.indexOf(state.preset)
      : state.cursor <= 4
        ? 5
        : state.cursor;
    return { type: "update", state: { ...state, cursor } };
  }
  if (key.leftArrow || key.rightArrow || input === "h" || input === "l") {
    const movingLeft = key.leftArrow || input === "h";
    if (state.cursor <= 1) {
      const cursor = movingLeft ? 0 : 1;
      return { type: "update", state: { ...state, cursor, mode: cursor === 0 ? "parallel" : "sequential" } };
    }
    if (state.cursor <= 4) {
      const currentPreset = state.cursor - 2;
      const nextPreset = (currentPreset + (movingLeft ? 2 : 1)) % 3;
      return { type: "update", state: { ...state, cursor: nextPreset + 2, preset: SAMPLE_PRESETS[nextPreset] } };
    }
    return { type: "none" };
  }
  if (input === "g") return { type: "update", state: { ...state, cursor: 0 } };
  if (input === "G") return { type: "update", state: { ...state, cursor: 5 } };
  if (key.return || input === " ") {
    const activation = configureActivation(state.cursor, key.return ? "enter" : "space");
    if (activation?.type === "start") return { type: "start" };
    if (activation?.type === "mode") return { type: "update", state: { ...state, mode: activation.value } };
    if (activation?.type === "preset") return { type: "update", state: { ...state, preset: activation.value } };
  }
  return { type: "none" };
}

interface RunningInputState {
  cursor: number;
  zoomed: boolean;
  columns: number;
  competitorCount: number;
}

export type RunningInputCommand =
  | { type: "none" }
  | { type: "cursor"; cursor: number }
  | { type: "zoom"; zoomed: boolean }
  | { type: "cancel" };

export function resolveRunningInput(
  state: RunningInputState,
  input: string,
  key: Key,
): RunningInputCommand {
  const lastIndex = Math.max(0, state.competitorCount - 1);
  const gridColumns = raceGridColumns(state.columns, state.competitorCount);
  if (key.leftArrow || input === "h") return { type: "cursor", cursor: Math.max(0, state.cursor - 1) };
  if (key.rightArrow || input === "l") return { type: "cursor", cursor: Math.min(lastIndex, state.cursor + 1) };
  if (key.upArrow || input === "k") return { type: "cursor", cursor: Math.max(0, state.cursor - gridColumns) };
  if (key.downArrow || input === "j") return { type: "cursor", cursor: Math.min(lastIndex, state.cursor + gridColumns) };
  if (input === "g") return { type: "cursor", cursor: 0 };
  if (input === "G") return { type: "cursor", cursor: lastIndex };
  if (/^\d$/.test(input) && Number(input) >= 1 && Number(input) <= MAX_RACERS) {
    return { type: "cursor", cursor: Math.min(lastIndex, Number(input) - 1) };
  }
  if (key.return || input === "z") return { type: "zoom", zoomed: !state.zoomed };
  if (key.escape) return state.zoomed ? { type: "zoom", zoomed: false } : { type: "cancel" };
  return { type: "none" };
}
