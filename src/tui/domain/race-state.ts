import type {
  Competitor,
  RunResult,
  ServerEvent,
  SummaryRow,
  WorkloadId,
} from "../../shared/types.js";
import { sanitizeTerminalOutput, sanitizeTerminalText } from "../sanitize.js";

const OUTPUT_TAIL_LIMIT = 12_000;

export type RaceEvent = Exclude<ServerEvent, { type: "providers" }>;
export type RacePhase = "idle" | "running" | "cancelled" | "complete" | "error";
export type RaceLaneStatus =
  | "queued"
  | "starting"
  | "ready"
  | "running"
  | "complete"
  | "invalid"
  | "error";

export interface RaceLane {
  competitorId: string;
  status: RaceLaneStatus;
  workload?: WorkloadId;
  sample?: number;
  warmup?: boolean;
  output: string;
  liveTps?: number;
  ttftMs?: number;
  totalMs?: number;
  completedRuns: number;
  error?: string;
}

export interface RaceIssue {
  competitorId: string;
  workload: WorkloadId;
  sample: number;
  warmup: boolean;
  message: string;
}

export interface RaceState {
  phase: RacePhase;
  benchmarkId?: string;
  totalRuns: number;
  completedRuns: number;
  seenRuns: ReadonlySet<string>;
  lanes: Record<string, RaceLane>;
  results: RunResult[];
  summary: SummaryRow[];
  issues: RaceIssue[];
  startedAt?: number;
  notice?: string;
}

function createLane(competitorId: string): RaceLane {
  return { competitorId, status: "queued", output: "", completedRuns: 0 };
}

export function createRaceState(competitors: readonly Pick<Competitor, "id">[] = []): RaceState {
  return {
    phase: "idle",
    totalRuns: 0,
    completedRuns: 0,
    seenRuns: new Set(),
    lanes: Object.fromEntries(competitors.map(({ id }) => [id, createLane(id)])),
    results: [],
    summary: [],
    issues: [],
  };
}

function runKey(event: Extract<RaceEvent, { type: "run.complete" | "run.error" }>): string {
  if (event.type === "run.complete") {
    const { competitorId, workload, sample, warmup } = event.result;
    return `${competitorId}\u0000${workload}\u0000${sample}\u0000${warmup}`;
  }
  return `${event.competitorId}\u0000${event.workload}\u0000${event.sample}\u0000${event.warmup}`;
}

function resetLanes(lanes: RaceState["lanes"]): RaceState["lanes"] {
  return Object.fromEntries(Object.keys(lanes).map((id) => [id, createLane(id)]));
}

export function reduceRaceEvent(
  state: RaceState,
  event: RaceEvent,
  now = performance.now(),
): RaceState {
  switch (event.type) {
    case "benchmark.started":
      return {
        ...state,
        phase: "running",
        benchmarkId: event.benchmarkId,
        totalRuns: event.totalRuns,
        completedRuns: 0,
        seenRuns: new Set(),
        lanes: resetLanes(state.lanes),
        results: [],
        summary: [],
        issues: [],
        startedAt: now,
        notice: undefined,
      };

    case "run.status": {
      const prior = state.lanes[event.competitorId] ?? createLane(event.competitorId);
      const changedRun = prior.workload !== event.workload ||
        prior.sample !== event.sample ||
        prior.warmup !== event.warmup;
      return {
        ...state,
        lanes: {
          ...state.lanes,
          [event.competitorId]: {
            ...prior,
            status: event.status,
            workload: event.workload,
            sample: event.sample,
            warmup: event.warmup,
            output: changedRun ? "" : prior.output,
            liveTps: changedRun ? undefined : prior.liveTps,
            ttftMs: changedRun ? undefined : prior.ttftMs,
            totalMs: changedRun ? undefined : prior.totalMs,
            error: event.message
              ? sanitizeTerminalText(event.message, "Unknown error", 2_000)
              : undefined,
          },
        },
      };
    }

    case "run.delta": {
      const prior = state.lanes[event.competitorId] ?? createLane(event.competitorId);
      return {
        ...state,
        lanes: {
          ...state.lanes,
          [event.competitorId]: {
            ...prior,
            status: "running",
            workload: event.workload,
            sample: event.sample,
            output: sanitizeTerminalOutput(`${prior.output}${event.text}`, OUTPUT_TAIL_LIMIT),
            liveTps: event.liveVisibleTokensPerSecond ?? prior.liveTps,
            ttftMs: prior.ttftMs ?? event.elapsedMs,
          },
        },
      };
    }

    case "run.complete": {
      const result = event.result;
      const prior = state.lanes[result.competitorId] ?? createLane(result.competitorId);
      const key = runKey(event);
      const first = !state.seenRuns.has(key);
      return {
        ...state,
        completedRuns: state.completedRuns + Number(first),
        seenRuns: first ? new Set([...state.seenRuns, key]) : state.seenRuns,
        results: first ? [...state.results, result] : state.results,
        lanes: {
          ...state.lanes,
          [result.competitorId]: {
            ...prior,
            status: result.valid ? "complete" : "invalid",
            workload: result.workload,
            sample: result.sample,
            warmup: result.warmup,
            output: sanitizeTerminalOutput(result.output || prior.output, OUTPUT_TAIL_LIMIT),
            liveTps: result.metrics.visibleTokensPerSecond,
            ttftMs: result.metrics.promptToFirstOutputMs,
            totalMs: result.metrics.promptToFinishMs,
            completedRuns: prior.completedRuns + Number(first),
            error: result.valid
              ? undefined
              : sanitizeTerminalText(
                  result.validationMessage ?? "invalid output",
                  "invalid output",
                  2_000,
                ),
          },
        },
      };
    }

    case "run.error": {
      const prior = state.lanes[event.competitorId] ?? createLane(event.competitorId);
      const changedRun = prior.workload !== event.workload ||
        prior.sample !== event.sample ||
        prior.warmup !== event.warmup;
      const key = runKey(event);
      const first = !state.seenRuns.has(key);
      const message = sanitizeTerminalText(event.message, "Unknown error", 2_000);
      return {
        ...state,
        completedRuns: state.completedRuns + Number(first),
        seenRuns: first ? new Set([...state.seenRuns, key]) : state.seenRuns,
        issues: first ? [...state.issues, {
          competitorId: event.competitorId,
          workload: event.workload,
          sample: event.sample,
          warmup: event.warmup,
          message,
        }] : state.issues,
        notice: message,
        lanes: {
          ...state.lanes,
          [event.competitorId]: {
            ...prior,
            status: "error",
            workload: event.workload,
            sample: event.sample,
            warmup: event.warmup,
            output: changedRun ? "" : prior.output,
            liveTps: changedRun ? undefined : prior.liveTps,
            ttftMs: changedRun ? undefined : prior.ttftMs,
            totalMs: changedRun ? undefined : prior.totalMs,
            completedRuns: prior.completedRuns + Number(first),
            error: message,
          },
        },
      };
    }

    case "benchmark.complete":
      return {
        ...state,
        phase: "complete",
        results: event.results,
        summary: [...event.summary].sort((left, right) =>
          Number(left.disqualified) - Number(right.disqualified) ||
          left.finishRank - right.finishRank
        ),
      };

    case "benchmark.cancelled":
      return { ...state, phase: "cancelled" };

    case "error":
      return {
        ...state,
        phase: "error",
        notice: sanitizeTerminalText(event.message, "Unknown error", 2_000),
      };
  }
}
