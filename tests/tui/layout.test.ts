import { describe, expect, it } from "vitest";

import {
  paneColumnCount,
  paneRows,
  resolveWorkspaceLayout,
} from "../../src/tui/domain/layout.js";

describe("native workspace layout", () => {
  it.each([
    [1, 140, 1],
    [2, 80, 2],
    [3, 80, 2],
    [3, 120, 3],
    [4, 160, 2],
    [5, 100, 2],
    [5, 120, 3],
    [6, 120, 3],
  ])("uses equal cells for %i panes at %i columns", (panes, width, expected) => {
    expect(paneColumnCount(panes, width)).toBe(expected);
  });

  it("pads an incomplete row instead of stretching its panes", () => {
    expect(paneRows([1, 2, 3, 4, 5], 3)).toEqual([
      [1, 2, 3],
      [4, 5, undefined],
    ]);
  });

  it("turns panels into overlays before they crowd the race canvas", () => {
    expect(resolveWorkspaceLayout(70)).toMatchObject({ showRoster: false, showInspector: false });
    expect(resolveWorkspaceLayout(141)).toMatchObject({ showRoster: false, showInspector: false });
    expect(resolveWorkspaceLayout(142)).toMatchObject({ showRoster: true, showInspector: false });
    expect(resolveWorkspaceLayout(171)).toMatchObject({ showRoster: true, showInspector: false });
    expect(resolveWorkspaceLayout(172)).toMatchObject({ showRoster: true, showInspector: true });
    expect(resolveWorkspaceLayout(180)).toMatchObject({ showRoster: true, showInspector: true });
  });

  it("never reduces six-lane grid columns when a panel docks", () => {
    const gridColumns = (terminalColumns: number) => {
      const layout = resolveWorkspaceLayout(terminalColumns);
      return paneColumnCount(6, layout.mainWidth - 2);
    };

    expect(gridColumns(142)).toBeGreaterThanOrEqual(gridColumns(141));
    expect(gridColumns(172)).toBeGreaterThanOrEqual(gridColumns(171));
  });
});
