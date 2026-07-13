import type { Competitor, HarnessId, ProviderInfo, SamplePreset, WorkloadId } from "../shared/types";

export type Phase = "setup" | "review" | "running" | "results";
export type SocketState = "connecting" | "open" | "closed";

export interface LaneState {
  output: string;
  status: "queued" | "starting" | "ready" | "running" | "complete" | "error";
  statusMessage?: string;
  workload?: WorkloadId;
  sample?: number;
  warmup?: boolean;
  setupStartedAt?: number;
  runningStartedAt?: number;
  harnessPrepMs?: number;
  firstOutputMs?: number;
  liveVisibleTokensPerSecond?: number;
  completedRuns: number;
  error?: string;
}

export const PRESETS: Array<{ id: SamplePreset; label: string; runs: string }> = [
  { id: "quick", label: "Quick", runs: "2 measured · no warmup" },
  { id: "standard", label: "Standard", runs: "6 measured · 2 warmups" },
  { id: "thorough", label: "Thorough", runs: "10 measured · 2 warmups" },
];

export const HARNESS_LABELS: Record<HarnessId, string> = {
  codex: "Codex",
  cursor: "Cursor",
  claudeAgent: "Claude",
  opencode: "OpenCode",
  grok: "Grok",
};

const COLORS = ["#cba6f7", "#94e2d5", "#f9e2af", "#89b4fa", "#fab387", "#f5c2e7"];

export const emptyLane = (): LaneState => ({
  output: "",
  status: "queued",
  completedRuns: 0,
});

export const formatMs = (value?: number) => {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)}s` : `${Math.round(value)}ms`;
};

export const formatVisibleRate = (value?: number) =>
  value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(value >= 100 ? 0 : 1)}`;

export const ordinal = (rank: number) => {
  const suffix = rank % 10 === 1 && rank % 100 !== 11 ? "st" : rank % 10 === 2 && rank % 100 !== 12 ? "nd" : rank % 10 === 3 && rank % 100 !== 13 ? "rd" : "th";
  return `${rank}${suffix}`;
};

const providerModel = (provider: ProviderInfo) =>
  provider.defaultModel ?? provider.models.find((model) => model.isDefault)?.id ?? provider.models[0]?.id ?? "default";

export function makeCompetitor(provider: ProviderInfo, index: number): Competitor {
  const model = providerModel(provider);
  return {
    id: crypto.randomUUID(),
    harness: provider.id,
    model,
    label: provider.models.find((option) => option.id === model)?.label ?? model,
    color: COLORS[index % COLORS.length],
  };
}

function defaultCompetitors(providers: ProviderInfo[]): Competitor[] {
  const runnable = providers.filter((provider) => provider.installed && provider.authenticated !== false && provider.models.length > 0);
  if (!runnable.length) return [];
  const count = Math.min(3, Math.max(2, runnable.length));
  return Array.from({ length: count }, (_, index) => makeCompetitor(runnable[index % runnable.length], index));
}

export function reconcileCompetitors(current: Competitor[], providers: ProviderInfo[]): Competitor[] {
  if (!current.length) return defaultCompetitors(providers);
  const runnable = providers.filter((provider) => provider.installed && provider.authenticated !== false && provider.models.length > 0);
  if (!runnable.length) return [];
  const providerMap = new Map(runnable.map((provider) => [provider.id, provider]));
  return current.map((competitor, index) => {
    const provider = providerMap.get(competitor.harness);
    if (provider?.models.some((model) => model.id === competitor.model)) return competitor;
    const replacement = makeCompetitor(runnable[index % runnable.length], index);
    return { ...replacement, id: competitor.id, color: competitor.color };
  });
}

export function providerResponse(payload: unknown): ProviderInfo[] {
  if (Array.isArray(payload)) return payload as ProviderInfo[];
  if (payload && typeof payload === "object" && "providers" in payload) {
    const providers = (payload as { providers?: unknown }).providers;
    return Array.isArray(providers) ? (providers as ProviderInfo[]) : [];
  }
  return [];
}
