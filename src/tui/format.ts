export function formatMs(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}s` : `${Math.round(value)}ms`;
}

export function formatRate(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(value >= 100 ? 0 : 1);
}
