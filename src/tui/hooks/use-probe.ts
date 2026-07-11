import { useCallback, useEffect, useState } from "react";

import { adapters as registeredAdapters } from "../../server/adapters/index.js";
import type { HarnessAdapter } from "../../server/adapters/types.js";
import {
  probeAdapters as probeRegisteredAdapters,
  type ProbedAdapter,
} from "../../terminal.js";

export type ProbeAdapters = (
  adapters: readonly HarnessAdapter[],
) => Promise<ProbedAdapter[]>;

export interface UseProbeOptions {
  adapters?: readonly HarnessAdapter[];
  probe?: ProbeAdapters;
}

export interface UseProbeResult {
  loading: boolean;
  results: ProbedAdapter[];
  error: Error | undefined;
  retry: () => void;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function useProbe({
  adapters = registeredAdapters,
  probe = probeRegisteredAdapters,
}: UseProbeOptions = {}): UseProbeResult {
  const [attempt, setAttempt] = useState(0);
  const [results, setResults] = useState<ProbedAdapter[]>([]);
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    let active = true;

    setLoading(true);
    setError(undefined);

    void (async () => {
      try {
        const nextResults = await probe(adapters);
        if (!active) return;
        setResults(nextResults);
        setLoading(false);
      } catch (cause) {
        if (!active) return;
        setError(asError(cause));
        setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [adapters, attempt, probe]);

  return { loading, results, error, retry };
}
