import { useInput } from "ink";
import type { RunMode, SamplePreset } from "../shared/types.js";
import { resolveConfigureInput, resolveLineupInput, resolveRunningInput } from "./input/navigation.js";
import { resolvePickerInput } from "./input/picker.js";
import type { Phase, PickerState } from "./types.js";

export interface TuiInputState {
  phase: Phase;
  columns: number;
  picker: PickerState;
  providerCount: number;
  filteredModelCount: number;
  selectedCount: number;
  lineupCursor: number;
  configCursor: number;
  mode: RunMode;
  preset: SamplePreset;
  laneCursor: number;
  zoomed: boolean;
  competitorCount: number;
}

export interface TuiInputActions {
  exit: () => void;
  interruptAndExit: () => void;
  setPhase: (phase: Phase) => void;
  setPicker: (state: PickerState) => void;
  choosePickerOption: () => void;
  openPicker: (slot: number) => void;
  setNotice: (message?: string) => void;
  setLineupCursor: (cursor: number) => void;
  removeRacer: (index: number) => void;
  continueToConfigure: () => void;
  updateConfigure: (state: { cursor: number; mode: RunMode; preset: SamplePreset }) => void;
  startRace: () => void;
  setLaneCursor: (cursor: number) => void;
  setZoomed: (zoomed: boolean) => void;
  cancelRace: () => void;
}

export function useTuiInput(state: TuiInputState, actions: TuiInputActions): void {
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      actions.interruptAndExit();
      return;
    }

    if (state.phase === "picker") {
      const command = resolvePickerInput(
        { state: state.picker, providerCount: state.providerCount, modelCount: state.filteredModelCount },
        input,
        key,
      );
      if (command.type === "update") actions.setPicker(command.state);
      else if (command.type === "choose") actions.choosePickerOption();
      else if (command.type === "back") actions.setPhase("lineup");
      return;
    }

    if (input === "q" && state.phase !== "running") {
      actions.exit();
      return;
    }
    if (state.phase === "error") {
      if (key.return || key.escape) actions.exit();
      return;
    }
    if (state.phase === "lineup") {
      const command = resolveLineupInput(state.selectedCount, state.lineupCursor, input, key);
      if (command.type === "cursor") actions.setLineupCursor(command.cursor);
      else if (command.type === "open-picker") actions.openPicker(command.slot);
      else if (command.type === "remove") actions.removeRacer(command.index);
      else if (command.type === "continue") actions.continueToConfigure();
      else if (command.type === "notice") actions.setNotice(command.message);
      return;
    }
    if (state.phase === "configure") {
      const command = resolveConfigureInput(
        { cursor: state.configCursor, mode: state.mode, preset: state.preset },
        input,
        key,
      );
      if (command.type === "back") actions.setPhase("lineup");
      else if (command.type === "start") actions.startRace();
      else if (command.type === "update") actions.updateConfigure(command.state);
      return;
    }
    if (state.phase === "running") {
      const command = resolveRunningInput(
        {
          cursor: state.laneCursor,
          zoomed: state.zoomed,
          columns: state.columns,
          competitorCount: state.competitorCount,
        },
        input,
        key,
      );
      if (command.type === "cursor") actions.setLaneCursor(command.cursor);
      else if (command.type === "zoom") actions.setZoomed(command.zoomed);
      else if (command.type === "cancel") actions.cancelRace();
      return;
    }
    if (state.phase === "results") {
      if (input === "r") actions.setPhase("configure");
      else if (key.return) actions.exit();
    }
  });
}
