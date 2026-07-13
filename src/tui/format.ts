export function formatMs(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}s` : `${Math.round(value)}ms`;
}

export function formatRate(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(value >= 100 ? 0 : 1);
}

export function formatProgressBar(done: number, total: number, width: number): string {
  const safeWidth = Math.max(0, Math.floor(width));
  const ratio = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  const filled = Math.round(ratio * safeWidth);
  return `${"━".repeat(filled)}${"─".repeat(safeWidth - filled)}`;
}
