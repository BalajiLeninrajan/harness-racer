export const HARNESS_IDS = ["codex", "claudeAgent", "cursor", "grok", "opencode"] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === "string" && (HARNESS_IDS as readonly string[]).includes(value);
}

export type RunMode = "parallel" | "sequential";
export type SamplePreset = "quick" | "standard" | "thorough";
export type WorkloadId = "prose" | "code";

export interface ModelOption {
  id: string;
  label: string;
  isDefault?: boolean;
}

export interface ProviderInfo {
  id: HarnessId;
  name: string;
  command: string;
  installed: boolean;
  authenticated: boolean | null;
  version?: string;
  message?: string;
  models: ModelOption[];
  defaultModel?: string;
}

export interface Competitor {
  id: string;
  harness: HarnessId;
  model: string;
  label: string;
  color: string;
}

export interface BenchmarkRequest {
  type: "start";
  competitors: Competitor[];
  mode: RunMode;
  samplePreset: SamplePreset;
}

export interface CancelRequest {
  type: "cancel";
}

export type ClientMessage = BenchmarkRequest | CancelRequest;

export interface RunMetrics {
  harnessPrepMs: number;
  promptToFirstOutputMs: number;
  coldStartToFirstOutputMs: number;
  visibleStreamMs: number;
  promptToFinishMs: number;
  visibleTokens: number;
  visibleTokensPerSecond: number;
  nativeOutputTokens?: number;
  streamChunkCount: number;
}

export interface RunResult {
  competitorId: string;
  workload: WorkloadId;
  sample: number;
  warmup: boolean;
  metrics: RunMetrics;
  output: string;
  valid: boolean;
  validationMessage?: string;
}

export interface SummaryRow {
  competitor: Competitor;
  measuredRuns: number;
  validRuns: number;
  anomalousRuns: number;
  disqualified: boolean;
  promptToFirstOutputMs: number;
  coldStartToFirstOutputMs: number;
  promptToFinishMs: number;
  visibleTokensPerSecond: number;
  finishRank: number;
  crowns: Array<"finish" | "firstOutput" | "coldStart" | "visibleSpeed">;
}

export type ServerEvent =
  | { type: "providers"; providers: ProviderInfo[] }
  | { type: "benchmark.started"; benchmarkId: string; totalRuns: number }
  | {
      type: "run.status";
      competitorId: string;
      workload: WorkloadId;
      sample: number;
      warmup: boolean;
      status: "queued" | "starting" | "ready" | "running" | "complete" | "error";
      message?: string;
    }
  | {
      type: "run.delta";
      competitorId: string;
      workload: WorkloadId;
      sample: number;
      text: string;
      elapsedMs: number;
      liveVisibleTokensPerSecond?: number;
    }
  | { type: "run.complete"; result: RunResult }
  | { type: "run.error"; competitorId: string; workload: WorkloadId; sample: number; message: string }
  | { type: "benchmark.complete"; results: RunResult[]; summary: SummaryRow[] }
  | { type: "benchmark.cancelled" }
  | { type: "error"; message: string };
