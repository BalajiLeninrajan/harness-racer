import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronRight,
  CircleStop,
  Code2,
  Flag,
  Gauge,
  LoaderCircle,
  Minus,
  Play,
  Plus,
  RotateCcw,
  Info,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { About } from "./About";
import { ModelLabLogo, modelLabName } from "./BrandLogo";
import { RacerPicker, type RacerChoice } from "./RacerPicker";
import type {
  ClientMessage,
  Competitor,
  HarnessId,
  ProviderInfo,
  RunMode,
  RunResult,
  SamplePreset,
  ServerEvent,
  SummaryRow,
  WorkloadId,
} from "../shared/types";

type Phase = "setup" | "review" | "running" | "results";
type Page = "benchmark" | "about";
type SocketState = "connecting" | "open" | "closed";

interface LaneState {
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

const COLORS = ["#cba6f7", "#94e2d5", "#f9e2af", "#89b4fa", "#fab387", "#f5c2e7"];
const PRESETS: Array<{ id: SamplePreset; label: string; runs: string }> = [
  { id: "quick", label: "Quick", runs: "2 runs" },
  { id: "standard", label: "Standard", runs: "2 warmups · 6 runs" },
  { id: "thorough", label: "Thorough", runs: "2 warmups · 10 runs" },
];

const HARNESS_LABELS: Record<HarnessId, string> = {
  codex: "Codex",
  cursor: "Cursor",
  claudeAgent: "Claude",
  opencode: "OpenCode",
  grok: "Grok",
};

const emptyLane = (): LaneState => ({
  output: "",
  status: "queued",
  completedRuns: 0,
});

const formatMs = (value?: number) => {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)}s` : `${Math.round(value)}ms`;
};

const formatVisibleRate = (value?: number) =>
  value === undefined || !Number.isFinite(value) ? "—" : `${value.toFixed(value >= 100 ? 0 : 1)}`;

const ordinal = (rank: number) => {
  const suffix = rank % 10 === 1 && rank % 100 !== 11 ? "st" : rank % 10 === 2 && rank % 100 !== 12 ? "nd" : rank % 10 === 3 && rank % 100 !== 13 ? "rd" : "th";
  return `${rank}${suffix}`;
};

const providerModel = (provider: ProviderInfo) =>
  provider.defaultModel ?? provider.models.find((model) => model.isDefault)?.id ?? provider.models[0]?.id ?? "default";

function makeCompetitor(provider: ProviderInfo, index: number): Competitor {
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

function reconcileCompetitors(current: Competitor[], providers: ProviderInfo[]): Competitor[] {
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

function providerResponse(payload: unknown): ProviderInfo[] {
  if (Array.isArray(payload)) return payload as ProviderInfo[];
  if (payload && typeof payload === "object" && "providers" in payload) {
    const providers = (payload as { providers?: unknown }).providers;
    return Array.isArray(providers) ? (providers as ProviderInfo[]) : [];
  }
  return [];
}

function ModelMark({ harness, model }: { harness: HarnessId; model: string }) {
  return (
    <span className={`harness-mark harness-${harness}`} aria-hidden="true">
      <ModelLabLogo harness={harness} model={model} size={16} />
    </span>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`metric ${accent ? "metric-accent" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function App() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState<string>();
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [mode, setMode] = useState<RunMode>(() => (localStorage.getItem("tps-racer.mode") as RunMode) || "parallel");
  const [preset, setPreset] = useState<SamplePreset>(() => (localStorage.getItem("tps-racer.preset") as SamplePreset) || "standard");
  const [page, setPage] = useState<Page>("benchmark");
  const [phase, setPhase] = useState<Phase>("setup");
  const [socketState, setSocketState] = useState<SocketState>("connecting");
  const [lanes, setLanes] = useState<Record<string, LaneState>>({});
  const [totalRuns, setTotalRuns] = useState(0);
  const [completedRuns, setCompletedRuns] = useState(0);
  const [results, setResults] = useState<RunResult[]>([]);
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [notice, setNotice] = useState<string>();
  const [now, setNow] = useState(() => performance.now());
  const socketRef = useRef<WebSocket | null>(null);
  const raceRef = useRef<HTMLDivElement | null>(null);
  const streamRefs = useRef<Record<string, HTMLPreElement | null>>({});

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

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    localStorage.setItem("tps-racer.mode", mode);
    localStorage.setItem("tps-racer.preset", preset);
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
        const event = JSON.parse(String(message.data)) as ServerEvent;
        handleServerEvent(event);
      } catch {
        setNotice("Received an unreadable message from the benchmark server.");
      }
    });

    return () => {
      if (socketRef.current === socket) socketRef.current = null;
      socket.close();
    };
    // The socket is intentionally created once for the app lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase !== "running") return;
    const timer = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    for (const [competitorId, stream] of Object.entries(streamRefs.current)) {
      if (!stream || lanes[competitorId]?.status !== "running") continue;
      const distanceFromBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
      if (distanceFromBottom < 56) stream.scrollTop = stream.scrollHeight;
    }
  }, [lanes]);

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
            setupStartedAt: event.status === "starting" ? time : newRun ? previous.setupStartedAt : previous.setupStartedAt,
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

  const providerMap = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);
  const runnableProviders = useMemo(() => providers.filter((provider) => provider.installed && provider.authenticated !== false && provider.models.length > 0), [providers]);
  const invalidSelections = competitors.filter((competitor) => {
    const provider = providerMap.get(competitor.harness);
    return !competitor.model.trim() || !provider?.installed || provider.authenticated === false || !provider.models.some((model) => model.id === competitor.model);
  });
  const canReview = competitors.length >= 2 && competitors.length <= 6 && invalidSelections.length === 0;
  const canStart = canReview && competitors.every((competitor) => competitor.label.trim());
  const expectedPerLane = totalRuns ? Math.ceil(totalRuns / Math.max(competitors.length, 1)) : 1;
  const activeWorkload = Object.values(lanes).find((lane) => lane.status === "running" || lane.status === "starting")?.workload;
  const invalidResults = results.filter((result) => !result.valid && !result.warmup);
  const eligibleSummary = summary.filter((row) => !row.disqualified);

  function updateCompetitor(id: string, patch: Partial<Competitor>) {
    setCompetitors((current) => current.map((competitor) => (competitor.id === id ? { ...competitor, ...patch } : competitor)));
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
    if (send({ type: "start", competitors, mode, samplePreset: preset })) {
      setPhase("running");
      window.requestAnimationFrame(() => raceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }

  function cancelRace() {
    send({ type: "cancel" });
  }

  function reviewRace() {
    setPhase("review");
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  function resetRace() {
    reviewRace();
    setNotice(undefined);
    setResults([]);
    setSummary([]);
    setLanes({});
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" disabled={phase === "running"} onClick={() => { setPage("benchmark"); setPhase("setup"); }} aria-label="TPS Racer home">
          <span className="brand-icon"><Gauge size={19} /></span>
          <span><b>tps</b>.racer</span>
        </button>
        <div className={page === "about" ? "page-context" : "phase-track"} aria-label={page === "about" ? "Current page" : "Benchmark progress"}>
          {page === "about" ? <><Info size={13} /> Methodology</> : <>
            <span className={phase === "setup" ? "active" : "done"}><i>1</i>Racers</span>
            <b />
            <span className={phase === "review" ? "active" : phase === "running" || phase === "results" ? "done" : ""}><i>2</i>Grid</span>
            <b />
            <span className={phase === "running" ? "active" : phase === "results" ? "done" : ""}><i>3</i>Race</span>
            <b />
            <span className={phase === "results" ? "active" : ""}><i>4</i>Results</span>
          </>}
        </div>
        <div className="topbar-actions">
          <button className={`about-button ${page === "about" ? "active" : ""}`} disabled={phase === "running"} onClick={() => setPage(page === "about" ? "benchmark" : "about")}><Info size={14} /> {page === "about" ? "Back to race" : "Methodology"}</button>
          <div className={`connection connection-${socketState}`} role="status">
            {socketState === "open" ? <Wifi size={14} /> : socketState === "connecting" ? <LoaderCircle className="spin" size={14} /> : <WifiOff size={14} />}
            {socketState === "open" ? "engine ready" : socketState === "connecting" ? "waking up" : "engine offline"}
          </div>
        </div>
      </header>

      <main>
        {page === "about" ? <About onBack={() => setPage("benchmark")} /> : <>
        {phase === "setup" && (
          <section className="setup-view page-enter">
            <div className="setup-workbench panel">
              <header className="setup-intro">
                <div>
                  <div className="eyebrow"><Flag size={14} /> STARTING LINEUP</div>
                  <h1>Choose your racers.</h1>
                </div>
                <span className="setup-count" aria-label={`${competitors.length} of 6 models selected`}>{competitors.length} <small>/ 6</small></span>
              </header>

              <div className="setup-content">
                {providersLoading ? (
                  <div className="empty-state"><LoaderCircle className="spin" /><strong>Scanning local agents…</strong><span>Checking installed harnesses and models</span></div>
                ) : providersError ? (
                  <div className="empty-state error-state"><AlertCircle /><strong>Agent scan failed</strong><span>{providersError}</span><button className="text-button" onClick={() => void loadProviders()}>Try again</button></div>
                ) : (
                  <div className="competitor-list">
                    {competitors.map((competitor) => (
                      <div className="competitor-card" key={competitor.id} style={{ "--lane-color": competitor.color } as React.CSSProperties}>
                        <RacerPicker providers={runnableProviders} harness={competitor.harness} model={competitor.model} onChange={(choice) => updateSelection(competitor.id, choice)} />
                        <button
                          className={`icon-button remove-button${competitors.length <= 2 ? " is-hidden" : ""}`}
                          onClick={() => removeCompetitor(competitor.id)}
                          disabled={competitors.length <= 2}
                          aria-hidden={competitors.length <= 2 ? true : undefined}
                          tabIndex={competitors.length <= 2 ? -1 : undefined}
                          aria-label={`Remove ${competitor.label}`}
                        ><Minus size={17} /></button>
                      </div>
                    ))}
                    {competitors.length < 6 && <button key="add-model" className="add-competitor" onClick={addCompetitor}><Plus size={17} /> Add model</button>}
                  </div>
                )}

                {!canReview && !providersLoading && competitors.length > 0 && (
                  <div className="inline-warning" role="alert"><AlertCircle size={15} /> Choose at least two available models.</div>
                )}
              </div>

              <div className="setup-actions">
                <button className="primary-button" disabled={!canReview || socketState !== "open"} onClick={reviewRace}>Set up race <ChevronRight size={18} /></button>
              </div>
            </div>
          </section>
        )}

        {phase === "review" && (
          <section className="review-view narrow-view page-enter">
            <button className="back-button" onClick={() => setPhase("setup")}><ArrowLeft size={16} /> Edit models</button>
            <div className="section-intro">
              <div>
                <div className="eyebrow"><Flag size={14} /> STARTING GRID</div>
                <h1>Name your racers.</h1>
                <p>Confirm the lineup, then start the benchmark.</p>
              </div>
              <div className="starting-lights" aria-hidden="true"><span /><span /><span /></div>
            </div>
            <div className="review-grid panel">
              <div className="race-options starting-grid-options">
                <div className="option-group">
                  <label className="option-label">Run order</label>
                  <div className="segmented">
                    <button aria-pressed={mode === "parallel"} className={mode === "parallel" ? "active" : ""} onClick={() => setMode("parallel")}><Activity size={16} /><span><b>Parallel</b><small>Run together</small></span></button>
                    <button aria-pressed={mode === "sequential"} className={mode === "sequential" ? "active" : ""} onClick={() => setMode("sequential")}><ChevronRight size={16} /><span><b>Sequential</b><small>One at a time</small></span></button>
                  </div>
                </div>
                <div className="option-group">
                  <label className="option-label">Samples</label>
                  <div className="preset-grid">
                    {PRESETS.map((option) => (
                      <button key={option.id} aria-pressed={preset === option.id} className={preset === option.id ? "active" : ""} onClick={() => setPreset(option.id)}>
                        <span className="radio-mark">{preset === option.id && <span />}</span>
                        <span><b>{option.label}</b><small>{option.runs}</small></span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="review-racers">
                {competitors.map((competitor, index) => (
                  <div key={competitor.id} className="review-racer" style={{ "--lane-color": competitor.color } as React.CSSProperties}>
                    <span className="review-number">{index + 1}</span>
                    <ModelMark harness={competitor.harness} model={competitor.model} />
                    <div className="review-racer-model"><strong>{providerMap.get(competitor.harness)?.models.find((model) => model.id === competitor.model)?.label ?? competitor.model}</strong><span>{modelLabName(competitor.model, competitor.harness)} · via {HARNESS_LABELS[competitor.harness]}</span></div>
                    <label className="review-name"><span>Race name</span><input value={competitor.label} maxLength={32} onChange={(event) => updateCompetitor(competitor.id, { label: event.target.value })} placeholder="Name this racer" /></label>
                  </div>
                ))}
              </div>
              {notice && <div className="inline-warning"><AlertCircle size={15} /> {notice}</div>}
              <button className="launch-button" onClick={startRace} disabled={!canStart || socketState !== "open"}>
                <span><Play size={21} fill="currentColor" /></span>
                <div><b>Start race</b><small>Run the benchmark</small></div>
                <ChevronRight size={21} />
              </button>
            </div>
          </section>
        )}

        {phase === "running" && (
          <section className="race-view page-enter" ref={raceRef}>
            <div className="race-header">
              <div>
                <div className="eyebrow"><span className="live-dot" /> LIVE TIMING</div>
                <h1>They’re off.</h1>
              </div>
              <div className="race-header-right">
                <div className="heat-switcher">
                  <span className={activeWorkload === "prose" ? "active" : activeWorkload === "code" ? "done" : ""}><span>01</span> Attention paper</span>
                  <i />
                  <span className={activeWorkload === "code" ? "active" : ""}><span>02</span> nanoGPT attention</span>
                </div>
                <button className="cancel-button" onClick={cancelRace}><CircleStop size={15} /> Cancel</button>
              </div>
            </div>

            <div className="overall-progress" role="progressbar" aria-label="Benchmark progress" aria-valuemin={0} aria-valuemax={totalRuns || 1} aria-valuenow={completedRuns}>
              <div><span>{completedRuns} / {totalRuns || "…"} runs complete</span><span>{totalRuns ? Math.round((completedRuns / totalRuns) * 100) : 0}%</span></div>
              <div className="progress-track"><span style={{ width: `${totalRuns ? Math.min(100, (completedRuns / totalRuns) * 100) : 2}%` }} /></div>
            </div>

            <div className="race-lanes">
              {competitors.map((competitor, index) => {
                const lane = lanes[competitor.id] ?? emptyLane();
                const elapsedHarnessPrep = lane.status === "starting" && lane.setupStartedAt ? now - lane.setupStartedAt : lane.harnessPrepMs;
                const elapsedFirstOutput = lane.status === "running" && lane.firstOutputMs === undefined && lane.runningStartedAt ? now - lane.runningStartedAt : lane.firstOutputMs;
                const laneProgress = Math.min(100, (lane.completedRuns / expectedPerLane) * 100);
                return (
                  <article className={`race-lane status-${lane.status}`} key={competitor.id} style={{ "--lane-color": competitor.color } as React.CSSProperties}>
                    <div className="lane-stripe" />
                    <div className="lane-head">
                      <span className="lane-position">P{index + 1}</span>
                      <ModelMark harness={competitor.harness} model={competitor.model} />
                      <div className="lane-identity"><strong>{competitor.label}</strong><span>{competitor.model}</span></div>
                      <div className="lane-status">
                        {lane.status === "running" ? <><span className="live-dot" /> STREAMING</> : lane.status === "starting" || lane.status === "ready" || lane.status === "queued" ? <><LoaderCircle className="spin" size={13} /> {lane.status.toUpperCase()}</> : lane.status === "error" ? <><AlertCircle size={13} /> ERROR</> : <><Check size={13} /> HEAT DONE</>}
                      </div>
                    </div>
                    <div className="lane-metrics">
                      <Metric label="HARNESS PREP" value={formatMs(elapsedHarnessPrep)} />
                      <Metric label="FIRST OUTPUT" value={formatMs(elapsedFirstOutput)} accent={lane.firstOutputMs !== undefined} />
                      <Metric label="VISIBLE TOK/S" value={formatVisibleRate(lane.liveVisibleTokensPerSecond)} accent={lane.liveVisibleTokensPerSecond !== undefined} />
                    </div>
                    <div className="stream-window">
                      <div className="stream-toolbar">
                        <span><Code2 size={13} /> {lane.workload === "code" ? "model.py" : lane.workload === "prose" ? "attention.txt" : "awaiting-stream"}</span>
                        <span>{lane.warmup ? "WARMUP" : lane.sample !== undefined ? `SAMPLE ${lane.sample}` : "QUEUED"}</span>
                      </div>
                      <pre ref={(element) => { streamRefs.current[competitor.id] = element; }}>{lane.output || (lane.status === "error" ? lane.error : "Waiting for the green light…")}<span className={lane.status === "running" ? "cursor" : "cursor hidden"} /></pre>
                    </div>
                    {lane.error && <div className="lane-error"><AlertCircle size={13} /> {lane.error}</div>}
                    <div className="lane-progress"><span style={{ width: `${laneProgress}%` }} /></div>
                  </article>
                );
              })}
            </div>
            {notice && <div className="inline-warning race-warning"><AlertCircle size={15} /> {notice}</div>}
          </section>
        )}

        {phase === "results" && (
          <section className="results-view page-enter">
            <div className="results-hero">
              <div>
                <div className="eyebrow"><Flag size={14} /> CHECKERED FLAG</div>
                <h1>Photo finish.</h1>
                <p>Median harness + model result across valid paper and Python runs.</p>
              </div>
            </div>

            {eligibleSummary.length >= 3 && (
              <div className="podium-showcase">
                <ol className="podium-grid" aria-label="Top three finishers">
                  {eligibleSummary.slice(0, 3).map((row) => (
                    <li className={`podium-entry rank-${row.finishRank}`} key={row.competitor.id} style={{ "--lane-color": row.competitor.color } as React.CSSProperties}>
                      <div className="podium-identity">
                        <span className="podium-rank">{ordinal(row.finishRank)}</span>
                        <ModelMark harness={row.competitor.harness} model={row.competitor.model} />
                        <strong>{row.competitor.label}</strong>
                        <small>{row.competitor.model}</small>
                        <b>{formatMs(row.promptToFinishMs)}</b>
                      </div>
                      <div className="podium-step" aria-hidden="true"><span>{row.finishRank}</span></div>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {eligibleSummary.length === 0 && (
              <div className="empty-state panel"><AlertCircle /><strong>No eligible finishers</strong><span>Recorded results are shown below as disqualified.</span></div>
            )}

            {summary.length > 0 && (
              <div className="results-table panel">
                <div className="table-title"><div><Flag size={18} /><h2>Full classification</h2></div><span>{results.filter((result) => result.valid && !result.warmup).length} valid runs{summary.some((row) => row.disqualified) ? ` · ${summary.filter((row) => row.disqualified).length} DSQ` : ""}</span></div>
                <div className="table-scroll">
                  <table>
                    <caption>Harness and model stacks with disqualified racers listed after ranked finishers</caption>
                    <thead><tr><th scope="col">Place</th><th scope="col">Harness + model</th><th scope="col">Prompt → first</th><th scope="col">Cold start → first</th><th scope="col">Visible tok/s</th><th scope="col">Prompt → finish</th><th scope="col">Runs</th></tr></thead>
                    <tbody>
                      {summary.map((row) => (
                        <tr className={row.disqualified ? "disqualified" : row.anomalousRuns > 0 ? "has-anomalies" : undefined} key={row.competitor.id}>
                          <td><span className={`position-badge ${row.disqualified ? "position-dsq" : `position-${row.finishRank}`}`}>{row.disqualified ? "DSQ" : row.finishRank}</span></td>
                          <td><div className="table-racer"><span className="table-lane-swatch" style={{ background: row.competitor.color }} /><ModelMark harness={row.competitor.harness} model={row.competitor.model} /><div><strong>{row.competitor.label}</strong><small>{row.competitor.model}</small>{row.anomalousRuns > 0 && <span className="anomaly-chip">{row.disqualified ? "all runs anomalous" : `${row.anomalousRuns} anomalous ${row.anomalousRuns === 1 ? "run" : "runs"}`}</span>}</div></div></td>
                          <td className={row.crowns.includes("firstOutput") ? "crowned" : ""}>{formatMs(row.promptToFirstOutputMs)}{row.crowns.includes("firstOutput") && <span className="best-chip">best</span>}</td>
                          <td className={row.crowns.includes("coldStart") ? "crowned" : ""}>{formatMs(row.coldStartToFirstOutputMs)}{row.crowns.includes("coldStart") && <span className="best-chip">best</span>}</td>
                          <td className={row.crowns.includes("visibleSpeed") ? "crowned" : ""}>{formatVisibleRate(row.visibleTokensPerSecond)}{row.crowns.includes("visibleSpeed") && <span className="best-chip">best</span>}</td>
                          <td className={row.crowns.includes("finish") ? "crowned" : ""}>{formatMs(row.promptToFinishMs)}{row.crowns.includes("finish") && <span className="best-chip">best</span>}</td>
                          <td><span className="run-count">{row.anomalousRuns > 0 ? `${row.validRuns}/${row.measuredRuns}` : row.measuredRuns}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {invalidResults.length > 0 && (
              <details className="invalid-results panel">
                <summary><span><AlertCircle size={15} /> {invalidResults.length} {invalidResults.length === 1 ? "run anomaly" : "run anomalies"}</span><ChevronRight size={15} /></summary>
                <div>
                  {invalidResults.map((result, index) => {
                    const competitor = competitors.find((item) => item.id === result.competitorId);
                    return (
                      <p key={`${result.competitorId}-${result.workload}-${result.sample}-${index}`}>
                        <strong>{competitor?.label ?? "Unknown racer"} · {result.workload} · sample {result.sample}</strong>
                        <span>{result.validationMessage ?? "The output was not valid for ranking."}</span>
                      </p>
                    );
                  })}
                </div>
              </details>
            )}

            <div className="results-actions">
              <button className="secondary-button" onClick={() => setPhase("setup")}><ArrowLeft size={16} /> Edit grid</button>
              <button className="primary-button" onClick={resetRace}><RotateCcw size={16} /> Race again</button>
            </div>
          </section>
        )}
        </>}
      </main>

      <footer>
        <div className="footer-brand"><Gauge size={16} /><strong><b>tps</b>.racer</strong><span>Model speed benchmark</span></div>
        <div className="footer-metrics"><span>TTFT</span><i /><span>TPS</span><i /><span>Total time</span></div>
      </footer>
    </div>
  );
}
