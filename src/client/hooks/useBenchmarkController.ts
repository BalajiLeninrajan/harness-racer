import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ClientMessage,
  Competitor,
  ProviderInfo,
  RunMode,
  RunResult,
  SamplePreset,
  ServerEvent,
  SummaryRow,
} from "../../shared/types";
import type { RacerChoice } from "../RacerPicker";
import {
  emptyLane,
  makeCompetitor,
  providerResponse,
  reconcileCompetitors,
  type LaneState,
  type Phase,
  type SocketState,
} from "../benchmark";

export function useBenchmarkController() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState<string>();
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [mode, setMode] = useState<RunMode>(() => (localStorage.getItem("harness-racer.mode") as RunMode) || "parallel");
  const [preset, setPreset] = useState<SamplePreset>(() => (localStorage.getItem("harness-racer.preset") as SamplePreset) || "standard");
  const [phase, setPhase] = useState<Phase>("setup");
  const [socketState, setSocketState] = useState<SocketState>("connecting");
  const [lanes, setLanes] = useState<Record<string, LaneState>>({});
  const [totalRuns, setTotalRuns] = useState(0);
  const [completedRuns, setCompletedRuns] = useState(0);
  const [results, setResults] = useState<RunResult[]>([]);
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [notice, setNotice] = useState<string>();
  const socketRef = useRef<WebSocket | null>(null);

  const loadProviders = useCallback(async () => {
    setProvidersLoading(true);
    setProvidersError(undefined);
    try {
      const response = await fetch("/api/providers");
      if (!response.ok) throw new Error(`Provider scan failed (${response.status})`);
      const nextProviders = providerResponse(await response.json());
      if (!nextProviders.length) throw new Error("No local harnesses were returned");
      setProviders(nextProviders);
      setCompetitors((current) => reconcileCompetitors(current, nextProviders));
    } catch (error) {
      setProvidersError(error instanceof Error ? error.message : "Could not scan local harnesses");
    } finally {
      setProvidersLoading(false);
    }
  }, []);

  const handleServerEvent = useCallback((event: ServerEvent) => {
    if (event.type === "providers") {
      setProviders(event.providers);
      setCompetitors((current) => reconcileCompetitors(current, event.providers));
      return;
    }

    if (event.type === "benchmark.started") {
      setTotalRuns(event.totalRuns);
      return;
    }

    if (event.type === "run.status") {
      const time = performance.now();
      setLanes((current) => {
        const previous = current[event.competitorId] ?? emptyLane();
        const newRun = previous.workload !== event.workload || previous.sample !== event.sample || previous.warmup !== event.warmup;
        return {
          ...current,
          [event.competitorId]: {
            ...previous,
            output: newRun && (event.status === "starting" || event.status === "queued") ? "" : previous.output,
            workload: event.workload,
            sample: event.sample,
            warmup: event.warmup,
            status: event.status,
            statusMessage: event.message,
            error: event.status === "error" ? event.message : undefined,
            liveVisibleTokensPerSecond: newRun ? undefined : previous.liveVisibleTokensPerSecond,
            firstOutputMs: newRun ? undefined : previous.firstOutputMs,
            harnessPrepMs: event.status === "ready" && previous.setupStartedAt ? time - previous.setupStartedAt : newRun ? undefined : previous.harnessPrepMs,
            setupStartedAt: event.status === "starting" ? time : previous.setupStartedAt,
            runningStartedAt: event.status === "running" ? time : newRun ? undefined : previous.runningStartedAt,
          },
        };
      });
      return;
    }

    if (event.type === "run.delta") {
      setLanes((current) => {
        const previous = current[event.competitorId] ?? emptyLane();
        return {
          ...current,
          [event.competitorId]: {
            ...previous,
            output: previous.output + event.text,
            status: "running",
            workload: event.workload,
            sample: event.sample,
            firstOutputMs: previous.firstOutputMs ?? event.elapsedMs,
            liveVisibleTokensPerSecond: event.liveVisibleTokensPerSecond ?? previous.liveVisibleTokensPerSecond,
          },
        };
      });
      return;
    }

    if (event.type === "run.complete") {
      setResults((current) => [...current, event.result]);
      setCompletedRuns((current) => current + 1);
      setLanes((current) => {
        const previous = current[event.result.competitorId] ?? emptyLane();
        return {
          ...current,
          [event.result.competitorId]: {
            ...previous,
            output: event.result.output || previous.output,
            status: "complete",
            harnessPrepMs: event.result.metrics.harnessPrepMs,
            firstOutputMs: event.result.metrics.promptToFirstOutputMs,
            liveVisibleTokensPerSecond: event.result.valid ? event.result.metrics.visibleTokensPerSecond : undefined,
            completedRuns: previous.completedRuns + 1,
            error: event.result.valid ? undefined : event.result.validationMessage,
          },
        };
      });
      return;
    }

    if (event.type === "run.error") {
      setCompletedRuns((current) => current + 1);
      setLanes((current) => ({
        ...current,
        [event.competitorId]: {
          ...(current[event.competitorId] ?? emptyLane()),
          status: "error",
          error: event.message,
          completedRuns: (current[event.competitorId]?.completedRuns ?? 0) + 1,
        },
      }));
      return;
    }

    if (event.type === "benchmark.complete") {
      setResults(event.results);
      setSummary([...event.summary].sort((a, b) => Number(a.disqualified) - Number(b.disqualified) || a.finishRank - b.finishRank));
      setCompletedRuns(event.results.length);
      setPhase("results");
      setNotice(undefined);
      return;
    }

    if (event.type === "benchmark.cancelled") {
      setPhase("review");
      setNotice("Race cancelled. No additional runs will be started.");
      return;
    }

    if (event.type === "error") setNotice(event.message);
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    localStorage.setItem("harness-racer.mode", mode);
    localStorage.setItem("harness-racer.preset", preset);
  }, [mode, preset]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    socketRef.current = socket;
    setSocketState("connecting");

    socket.addEventListener("open", () => {
      if (socketRef.current === socket) setSocketState("open");
    });
    socket.addEventListener("close", () => {
      if (socketRef.current !== socket) return;
      setSocketState("closed");
      setPhase((current) => {
        if (current === "running") setNotice("The local benchmark server disconnected.");
        return current;
      });
    });
    socket.addEventListener("error", () => {
      if (socketRef.current === socket) setSocketState("closed");
    });
    socket.addEventListener("message", (message) => {
      if (socketRef.current !== socket) return;
      try {
        handleServerEvent(JSON.parse(String(message.data)) as ServerEvent);
      } catch {
        setNotice("Received an unreadable message from the benchmark server.");
      }
    });

    return () => {
      if (socketRef.current === socket) socketRef.current = null;
      socket.close();
    };
  }, [handleServerEvent]);

  const providerMap = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);
  const runnableProviders = useMemo(() => providers.filter((provider) => provider.installed && provider.authenticated !== false && provider.models.length > 0), [providers]);
  const invalidSelections = competitors.filter((competitor) => {
    const provider = providerMap.get(competitor.harness);
    return !competitor.model.trim() || !provider?.installed || provider.authenticated === false || !provider.models.some((model) => model.id === competitor.model);
  });
  const canReview = competitors.length >= 2 && competitors.length <= 6 && invalidSelections.length === 0;
  const canStart = canReview && competitors.every((competitor) => competitor.label.trim());

  function updateCompetitorName(id: string, label: string) {
    setCompetitors((current) => current.map((competitor) => (competitor.id === id ? { ...competitor, label } : competitor)));
  }

  function updateSelection(id: string, choice: RacerChoice) {
    setCompetitors((current) => current.map((competitor) => {
      if (competitor.id !== id) return competitor;
      const previousModel = providerMap.get(competitor.harness)?.models.find((model) => model.id === competitor.model);
      const labelWasAutomatic = !competitor.label.trim() || competitor.label === competitor.model || competitor.label === previousModel?.label;
      return {
        ...competitor,
        harness: choice.provider.id,
        model: choice.model.id,
        label: labelWasAutomatic ? choice.model.label : competitor.label,
      };
    }));
  }

  function addCompetitor() {
    if (competitors.length >= 6 || !runnableProviders.length) return;
    const used = new Set(competitors.map((competitor) => competitor.harness));
    const provider = runnableProviders.find((candidate) => !used.has(candidate.id)) ?? runnableProviders[competitors.length % runnableProviders.length];
    setCompetitors((current) => [...current, makeCompetitor(provider, current.length)]);
  }

  function removeCompetitor(id: string) {
    if (competitors.length <= 2) return;
    setCompetitors((current) => current.filter((competitor) => competitor.id !== id));
  }

  function send(message: ClientMessage) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setNotice("The local benchmark server is not connected yet.");
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }

  function startRace() {
    if (!canStart) return;
    setNotice(undefined);
    setResults([]);
    setSummary([]);
    setTotalRuns(0);
    setCompletedRuns(0);
    setLanes(Object.fromEntries(competitors.map((competitor) => [competitor.id, emptyLane()])));
    if (send({ type: "start", competitors, mode, samplePreset: preset })) setPhase("running");
  }

  function resetRace() {
    setPhase("review");
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
    setNotice(undefined);
    setResults([]);
    setSummary([]);
    setLanes({});
  }

  function reviewRace() {
    setPhase("review");
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  return {
    providers,
    runnableProviders,
    providersLoading,
    providersError,
    competitors,
    mode,
    preset,
    phase,
    socketState,
    lanes,
    totalRuns,
    completedRuns,
    results,
    summary,
    notice,
    canReview,
    canStart,
    loadProviders,
    updateSelection,
    updateCompetitorName,
    addCompetitor,
    removeCompetitor,
    setMode,
    setPreset,
    showSetup: () => setPhase("setup"),
    reviewRace,
    startRace,
    cancelRace: () => { send({ type: "cancel" }); },
    resetRace,
  };
}
