import { useCallback, useEffect, useRef, useState } from "react";
import type { BenchmarkRequest } from "../shared/types.js";
import { adapters } from "../server/adapters/index.js";
import { runBenchmark } from "../server/benchmark.js";
import { emptyRaceState, reduceRaceEvent, type TuiRaceState } from "./model.js";

export type RaceOutcome =
  | { type: "completed" }
  | { type: "cancelled" }
  | { type: "stale" }
  | { type: "failed"; message: string };

export interface RaceRunner {
  race: TuiRaceState;
  start: (request: BenchmarkRequest) => Promise<RaceOutcome>;
  cancel: (reason?: Error) => void;
}

export function useRaceRunner(): RaceRunner {
  const [race, setRace] = useState<TuiRaceState>(emptyRaceState);
  const controller = useRef<AbortController | undefined>(undefined);
  const runSequence = useRef(0);

  const cancel = useCallback((reason = new Error("Race cancelled.")) => {
    controller.current?.abort(reason);
  }, []);

  const start = useCallback(async (request: BenchmarkRequest): Promise<RaceOutcome> => {
    controller.current?.abort(new Error("A new race started."));
    const abortController = new AbortController();
    const runId = ++runSequence.current;
    controller.current = abortController;
    setRace(emptyRaceState());

    try {
      await runBenchmark(
        request,
        adapters,
        abortController.signal,
        (event) => {
          if (runSequence.current === runId) setRace((current) => reduceRaceEvent(current, event));
        },
      );
      if (runSequence.current !== runId) return { type: "stale" };
      return { type: "completed" };
    } catch (reason) {
      if (runSequence.current !== runId) return { type: "stale" };
      if (abortController.signal.aborted) return { type: "cancelled" };
      const message = reason instanceof Error ? reason.message : String(reason);
      if (runSequence.current === runId) setRace((current) => ({ ...current, error: message }));
      return { type: "failed", message };
    } finally {
      if (controller.current === abortController) controller.current = undefined;
    }
  }, []);

  useEffect(() => () => {
    runSequence.current += 1;
    controller.current?.abort(new Error("Terminal closed."));
  }, []);

  return { race, start, cancel };
}
