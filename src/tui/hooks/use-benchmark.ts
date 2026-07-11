import { useCallback, useEffect, useRef, useState } from "react";

import type { BenchmarkRequest, Competitor, ServerEvent } from "../../shared/types.js";
import type { BenchmarkRunner, RunnableAdapter } from "../../terminal.js";
import {
  createRaceState,
  reduceRaceEvent,
  type RaceEvent,
  type RaceState,
} from "../domain/race-state.js";
import { sanitizeTerminalText } from "../sanitize.js";

interface ActiveRace {
  id: number;
  controller: AbortController;
  pending: RaceEvent[];
  frameTimer?: ReturnType<typeof setTimeout>;
  terminalSeen: boolean;
  settled?: Promise<void>;
}

const FRAME_BATCH_MS = 16;

export interface UseBenchmarkOptions {
  runner: BenchmarkRunner;
  runnable: readonly RunnableAdapter[];
}

export interface UseBenchmarkResult {
  state: RaceState;
  active: boolean;
  start: (request: BenchmarkRequest) => void;
  cancel: () => Promise<void>;
  reset: (competitors?: readonly Competitor[]) => void;
  shutdown: () => Promise<void>;
}

function messageFrom(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return sanitizeTerminalText(value, "Unknown benchmark error", 2_000);
}

function isTerminalEvent(event: ServerEvent): boolean {
  return event.type === "benchmark.complete" ||
    event.type === "benchmark.cancelled" ||
    event.type === "error";
}

function discardPending(race: ActiveRace): void {
  if (race.frameTimer !== undefined) {
    clearTimeout(race.frameTimer);
    race.frameTimer = undefined;
  }
  race.pending.length = 0;
}

export function useBenchmark({ runner, runnable }: UseBenchmarkOptions): UseBenchmarkResult {
  const [state, setState] = useState<RaceState>(() => createRaceState());
  const [active, setActive] = useState(false);
  const activeRace = useRef<ActiveRace | undefined>(undefined);
  const latestSettlement = useRef<Promise<void>>(Promise.resolve());
  // Unlike activeRace, this remains set after a runner settles so React may
  // safely commit its final queued update. Starting, resetting, or cancelling
  // a race changes the owner and makes already-scheduled updates no-ops.
  const stateOwner = useRef<number | undefined>(undefined);
  const nextId = useRef(1);
  const mounted = useRef(true);

  const flush = useCallback((
    race: ActiveRace,
    finalize?: (state: RaceState) => RaceState,
  ) => {
    if (race.frameTimer !== undefined) {
      clearTimeout(race.frameTimer);
      race.frameTimer = undefined;
    }

    const events = race.pending.splice(0);
    if (events.length === 0 && !finalize) return;

    setState((previous) => {
      if (!mounted.current || stateOwner.current !== race.id) return previous;
      const reduced = events.reduce<RaceState>(
        (next, event) => reduceRaceEvent(next, event),
        previous,
      );
      return finalize ? finalize(reduced) : reduced;
    });
  }, []);

  const cancel = useCallback((): Promise<void> => {
    const current = activeRace.current;
    if (!current) return latestSettlement.current.catch(() => undefined);

    // Invalidate the race before aborting. Abort listeners run synchronously
    // and may try to emit one last event, which must not revive cancelled state.
    activeRace.current = undefined;
    stateOwner.current = undefined;
    discardPending(current);
    current.controller.abort(new DOMException("Benchmark cancelled", "AbortError"));
    if (mounted.current) {
      setActive(false);
      setState((previous) => ({ ...previous, phase: "cancelled" }));
    }
    return latestSettlement.current.catch(() => undefined);
  }, []);

  const reset = useCallback((competitors: readonly Competitor[] = []) => {
    void cancel();
    stateOwner.current = undefined;
    if (mounted.current) setState(createRaceState(competitors));
  }, [cancel]);

  const start = useCallback((request: BenchmarkRequest) => {
    const priorSettlement = latestSettlement.current;
    void cancel();

    const id = nextId.current++;
    const controller = new AbortController();
    const selectedHarnesses = new Set(request.competitors.map(({ harness }) => harness));
    const adapters = runnable
      .filter(({ adapter }) => selectedHarnesses.has(adapter.id))
      .map(({ adapter }) => adapter);
    const race: ActiveRace = {
      id,
      controller,
      pending: [],
      terminalSeen: false,
    };

    activeRace.current = race;
    stateOwner.current = id;
    setState({ ...createRaceState(request.competitors), phase: "running" });
    setActive(true);

    const emit = (event: ServerEvent) => {
      if (
        activeRace.current !== race ||
        race.terminalSeen ||
        event.type === "providers"
      ) return;

      const terminal = isTerminalEvent(event);
      race.terminalSeen = terminal;
      race.pending.push(event as RaceEvent);

      if (terminal) {
        // Completion and failure should be visible immediately, while ordinary
        // streaming deltas share one React update per terminal frame.
        flush(race);
      } else if (race.frameTimer === undefined) {
        race.frameTimer = setTimeout(() => {
          race.frameTimer = undefined;
          if (activeRace.current !== race) {
            race.pending.length = 0;
            return;
          }
          flush(race);
        }, FRAME_BATCH_MS);
      }
    };

    race.settled = Promise.resolve()
      .then(() => runner(request, adapters, controller.signal, emit))
      .then(() => {
        if (!mounted.current || activeRace.current?.id !== id) return;
        if (!race.terminalSeen && !controller.signal.aborted) {
          race.terminalSeen = true;
          flush(race, (previous) => ({
            ...previous,
            phase: "error",
            notice: "The benchmark ended without final results.",
          }));
        }
      })
      .catch((error: unknown) => {
        if (!mounted.current || activeRace.current?.id !== id || controller.signal.aborted) return;
        race.terminalSeen = true;
        flush(race, (previous) => ({
          ...previous,
          phase: "error",
          notice: messageFrom(error),
        }));
      })
      .finally(() => {
        if (!mounted.current || activeRace.current?.id !== id) return;
        discardPending(race);
        activeRace.current = undefined;
        setActive(false);
      });
    latestSettlement.current = Promise.allSettled([priorSettlement, race.settled]).then(() => undefined);
  }, [cancel, flush, runnable, runner]);

  const shutdown = useCallback(() => cancel(), [cancel]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stateOwner.current = undefined;
      const current = activeRace.current;
      activeRace.current = undefined;
      if (current) {
        discardPending(current);
        current.controller.abort(new DOMException("TUI closed", "AbortError"));
      }
    };
  }, []);

  return { state, active, start, cancel, reset, shutdown };
}
