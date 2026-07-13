import type { Key } from "ink";
import type { PickerState } from "../types.js";

export type PickerInputCommand =
  | { type: "none" }
  | { type: "update"; state: PickerState }
  | { type: "choose" }
  | { type: "back" };

interface PickerInputContext {
  state: PickerState;
  providerCount: number;
  modelCount: number;
}

function update(state: PickerState, changes: Partial<PickerState>): PickerInputCommand {
  return { type: "update", state: { ...state, ...changes } };
}

export function resolvePickerInput(
  { state, providerCount, modelCount }: PickerInputContext,
  input: string,
  key: Key,
): PickerInputCommand {
  if (key.escape) {
    return state.searching ? update(state, { searching: false }) : { type: "back" };
  }

  const safeModelCount = Math.max(1, modelCount);
  if (state.searching) {
    if (key.upArrow || (key.ctrl && input === "p")) {
      return update(state, { modelCursor: (state.modelCursor - 1 + safeModelCount) % safeModelCount });
    }
    if (key.downArrow || (key.ctrl && input === "n")) {
      return update(state, { modelCursor: (state.modelCursor + 1) % safeModelCount });
    }
    if (key.backspace || key.delete) return update(state, { query: state.query.slice(0, -1), modelCursor: 0 });
    if (key.ctrl && input === "u") return update(state, { query: "", modelCursor: 0 });
    if (key.return) return { type: "choose" };
    if (input && !key.ctrl && !key.meta && !key.tab) return update(state, { query: state.query + input, modelCursor: 0 });
    return { type: "none" };
  }

  if (input === "q") return { type: "back" };
  if (input === "/") return update(state, { focus: "models", searching: true });
  if (input === "c") return update(state, { query: "", modelCursor: 0 });
  if (key.tab) return update(state, { focus: state.focus === "providers" ? "models" : "providers" });

  if (state.focus === "providers") {
    const safeProviderCount = Math.max(1, providerCount);
    if (key.upArrow || input === "k") {
      return update(state, {
        providerCursor: (state.providerCursor - 1 + safeProviderCount) % safeProviderCount,
        modelCursor: 0,
        query: "",
        searching: false,
      });
    }
    if (key.downArrow || input === "j") {
      return update(state, {
        providerCursor: (state.providerCursor + 1) % safeProviderCount,
        modelCursor: 0,
        query: "",
        searching: false,
      });
    }
    if (key.home || input === "g") return update(state, { providerCursor: 0, modelCursor: 0, query: "" });
    if (key.end || input === "G") return update(state, { providerCursor: Math.max(0, providerCount - 1), modelCursor: 0, query: "" });
    if (key.rightArrow || input === "l" || key.return) return update(state, { focus: "models" });
    return { type: "none" };
  }

  if (key.leftArrow || input === "h") return update(state, { focus: "providers" });
  if (key.upArrow || input === "k") return update(state, { modelCursor: (state.modelCursor - 1 + safeModelCount) % safeModelCount });
  if (key.downArrow || input === "j") return update(state, { modelCursor: (state.modelCursor + 1) % safeModelCount });
  if (key.home || input === "g") return update(state, { modelCursor: 0 });
  if (key.end || input === "G") return update(state, { modelCursor: Math.max(0, modelCount - 1) });
  if (key.pageUp || key.pageDown) {
    const direction = key.pageUp ? -1 : 1;
    return update(state, { modelCursor: Math.max(0, Math.min(Math.max(0, modelCount - 1), state.modelCursor + direction * 8)) });
  }
  if (key.return) return { type: "choose" };
  return { type: "none" };
}
