import type { Key } from "ink";
import { describe, expect, it } from "vitest";
import { resolveConfigureInput, resolveLineupInput, resolveRunningInput } from "../src/tui/input/navigation.js";
import { resolvePickerInput } from "../src/tui/input/picker.js";
import type { PickerState } from "../src/tui/types.js";

function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...overrides,
  };
}

const picker: PickerState = {
  slot: 0,
  providerCursor: 0,
  modelCursor: 0,
  focus: "models",
  query: "",
  searching: false,
};

describe("terminal input resolvers", () => {
  it("keeps search input ahead of global shortcuts", () => {
    const searching = { ...picker, searching: true };
    expect(resolvePickerInput({ state: searching, providerCount: 3, modelCount: 8 }, "q", key())).toEqual({
      type: "update",
      state: { ...searching, query: "q" },
    });
    expect(resolvePickerInput({ state: searching, providerCount: 3, modelCount: 8 }, "", key({ escape: true }))).toEqual({
      type: "update",
      state: { ...searching, searching: false },
    });
    expect(resolvePickerInput({ state: picker, providerCount: 3, modelCount: 8 }, "q", key())).toEqual({ type: "back" });
  });

  it("moves between picker tiers and chooses only from the model tier", () => {
    const providers = { ...picker, focus: "providers" as const, providerCursor: 1 };
    expect(resolvePickerInput({ state: providers, providerCount: 3, modelCount: 8 }, "j", key())).toMatchObject({
      type: "update",
      state: { providerCursor: 2, modelCursor: 0 },
    });
    expect(resolvePickerInput({ state: providers, providerCount: 3, modelCount: 8 }, "", key({ return: true }))).toMatchObject({
      type: "update",
      state: { focus: "models" },
    });
    expect(resolvePickerInput({ state: picker, providerCount: 3, modelCount: 8 }, "", key({ return: true }))).toEqual({ type: "choose" });
  });

  it("resolves lineup navigation and actions without React state", () => {
    expect(resolveLineupInput(3, 0, "a", key())).toEqual({ type: "open-picker", slot: 3 });
    expect(resolveLineupInput(6, 0, "a", key())).toEqual({ type: "notice", message: "A race supports at most six racers." });
    expect(resolveLineupInput(3, 1, "d", key())).toEqual({ type: "remove", index: 1 });
    expect(resolveLineupInput(3, 4, "", key({ return: true }))).toEqual({ type: "continue" });
  });

  it("starts with Enter from every grid position and uses Space for selection", () => {
    for (let cursor = 0; cursor <= 5; cursor += 1) {
      expect(resolveConfigureInput({ cursor, mode: "parallel", preset: "standard" }, "", key({ return: true }))).toEqual({ type: "start" });
    }
    expect(resolveConfigureInput({ cursor: 1, mode: "parallel", preset: "standard" }, " ", key())).toEqual({
      type: "update",
      state: { cursor: 1, mode: "sequential", preset: "standard" },
    });
    expect(resolveConfigureInput({ cursor: 4, mode: "parallel", preset: "quick" }, " ", key())).toEqual({
      type: "update",
      state: { cursor: 4, mode: "parallel", preset: "thorough" },
    });
  });

  it("keeps running navigation and cancel semantics isolated", () => {
    const state = { cursor: 2, zoomed: false, columns: 120, competitorCount: 6 };
    expect(resolveRunningInput(state, "j", key())).toEqual({ type: "cursor", cursor: 5 });
    expect(resolveRunningInput(state, "z", key())).toEqual({ type: "zoom", zoomed: true });
    expect(resolveRunningInput({ ...state, zoomed: true }, "", key({ escape: true }))).toEqual({ type: "zoom", zoomed: false });
    expect(resolveRunningInput(state, "", key({ escape: true }))).toEqual({ type: "cancel" });
  });
});
