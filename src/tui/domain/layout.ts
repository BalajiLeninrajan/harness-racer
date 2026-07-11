export interface WorkspaceLayout {
  showRoster: boolean;
  rosterWidth: number;
  showInspector: boolean;
  inspectorWidth: number;
  mainWidth: number;
}

const ROSTER_WIDTH = 31;
const INSPECTOR_WIDTH = 31;
const ROSTER_DOCK_COLUMNS = 142;
const INSPECTOR_DOCK_COLUMNS = 172;

/** Keep the canvas usable as the terminal narrows; hidden panels become overlays. */
export function resolveWorkspaceLayout(columns: number): WorkspaceLayout {
  // Dock panels only when doing so preserves the widest 1–6-lane topology.
  // Below these thresholds they remain overlays instead of making a slightly
  // wider terminal display fewer live panes per row.
  const showRoster = columns >= ROSTER_DOCK_COLUMNS;
  // The optional inspector only docks when three 30-ish-column live panes can
  // still fit beside both side panels. At ordinary widths it is an overlay.
  const showInspector = columns >= INSPECTOR_DOCK_COLUMNS;
  const rosterWidth = showRoster ? ROSTER_WIDTH : 0;
  const inspectorWidth = showInspector ? INSPECTOR_WIDTH : 0;
  return {
    showRoster,
    rosterWidth,
    showInspector,
    inspectorWidth,
    mainWidth: Math.max(1, columns - rosterWidth - inspectorWidth),
  };
}

/** Equal-cell tmux-style layouts; four racers deliberately remain a balanced 2x2. */
export function paneColumnCount(paneCount: number, availableColumns: number): number {
  if (paneCount <= 1 || availableColumns < 66) return 1;
  if (paneCount === 2 || paneCount === 4) return 2;
  if (paneCount >= 5 && availableColumns >= 108) return 3;
  if (paneCount === 3 && availableColumns >= 102) return 3;
  return 2;
}

export function paneRows<T>(items: readonly T[], columns: number): Array<Array<T | undefined>> {
  const rows: Array<Array<T | undefined>> = [];
  for (let index = 0; index < items.length; index += columns) {
    const row: Array<T | undefined> = [...items.slice(index, index + columns)];
    while (row.length < columns) row.push(undefined);
    rows.push(row);
  }
  return rows;
}
