import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Bot,
  Check,
  ChevronRight,
  CircleStop,
  Clock3,
  Code2,
  Flag,
  Gauge,
  LoaderCircle,
  Minus,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Sparkles,
  Terminal,
  Trophy,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HarnessPicker } from "./HarnessPicker";
import { ModelPicker } from "./ModelPicker";
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
  setupMs?: number;
  ttftMs?: number;
  liveTps?: number;
  completedRuns: number;
  error?: string;
}

const COLORS = ["#cba6f7", "#94e2d5", "#f9e2af", "#89b4fa", "#fab387", "#f5c2e7"];
const PRESETS: Array<{ id: SamplePreset; label: string; detail: string; runs: string }> = [
  { id: "quick", label: "Quick", detail: "A fast signal", runs: "2 heats" },
  { id: "standard", label: "Standard", detail: "Balanced accuracy", runs: "2 warmups + 6 runs" },
  { id: "thorough", label: "Thorough", detail: "Highest confidence", runs: "2 warmups + 10 runs" },
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

const formatTps = (value?: number) =>
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

function HarnessMark({ harness }: { harness: HarnessId }) {
  const icon = harness === "codex"
    ? <Sparkles size={15} />
    : harness === "cursor"
      ? <Terminal size={15} />
      : harness === "claudeAgent"
        ? <Bot size={15} />
        : harness === "opencode"
          ? <Code2 size={15} />
          : <Zap size={15} />;
  return (
    <span className={`harness-mark harness-${harness}`} aria-hidden="true">
      {icon}
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
            liveTps: newRun ? undefined : previous.liveTps,
            ttftMs: newRun ? undefined : previous.ttftMs,
            setupMs: event.status === "ready" && previous.setupStartedAt ? time - previous.setupStartedAt : newRun ? undefined : previous.setupMs,
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
            ttftMs: previous.ttftMs ?? event.elapsedMs,
            liveTps: event.liveTps ?? previous.liveTps,
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
            setupMs: event.result.metrics.setupMs,
            ttftMs: event.result.metrics.modelTtftMs,
            liveTps: event.result.metrics.normalizedTps,
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
      setSummary([...event.summary].sort((a, b) => a.overallRank - b.overallRank));
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
  const installedProviders = useMemo(() => providers.filter((provider) => provider.installed), [providers]);
  const runnableProviders = useMemo(() => installedProviders.filter((provider) => provider.authenticated !== false && provider.models.length > 0), [installedProviders]);
  const invalidCompetitors = competitors.filter((competitor) => {
    const provider = providerMap.get(competitor.harness);
    return !competitor.label.trim() || !competitor.model.trim() || !provider?.installed || provider.authenticated === false || !provider.models.some((model) => model.id === competitor.model);
  });
  const canReview = competitors.length >= 2 && competitors.length <= 6 && invalidCompetitors.length === 0;
  const expectedPerLane = totalRuns ? Math.ceil(totalRuns / Math.max(competitors.length, 1)) : 1;
  const activeWorkload = Object.values(lanes).find((lane) => lane.status === "running" || lane.status === "starting")?.workload;
  const invalidResults = results.filter((result) => !result.valid && !result.warmup);
  const winner = summary[0];
  const winningMargin = winner && summary[1] ? Math.max(0, summary[1].totalMs - winner.totalMs) : undefined;

  function updateCompetitor(id: string, patch: Partial<Competitor>) {
    setCompetitors((current) => current.map((competitor) => (competitor.id === id ? { ...competitor, ...patch } : competitor)));
  }

  function updateHarness(id: string, harness: HarnessId) {
    const provider = providerMap.get(harness);
    if (!provider) return;
    const model = providerModel(provider);
    updateCompetitor(id, {
      harness,
      model,
      label: provider.models.find((option) => option.id === model)?.label ?? model,
    });
  }

  function updateModel(id: string, model: { id: string; label: string }) {
    updateCompetitor(id, { model: model.id, label: model.label });
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
    if (!canReview) return;
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

  function resetRace() {
    setPhase("review");
    setNotice(undefined);
    setResults([]);
    setSummary([]);
    setLanes({});
  }

  return (
    <div className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="topbar">
        <button className="brand" disabled={phase === "running"} onClick={() => setPhase("setup")} aria-label="TPS Racer home">
          <span className="brand-icon"><Gauge size={19} /></span>
          <span><b>tps</b>.racer</span>
          <span className="version">local</span>
        </button>
        <div className="phase-track" aria-label="Benchmark progress">
          <span className={phase === "setup" ? "active" : "done"}><i>1</i>Grid</span>
          <b />
          <span className={phase === "review" ? "active" : phase === "running" || phase === "results" ? "done" : ""}><i>2</i>Check</span>
          <b />
          <span className={phase === "running" ? "active" : phase === "results" ? "done" : ""}><i>3</i>Race</span>
          <b />
          <span className={phase === "results" ? "active" : ""}><i>4</i>Finish</span>
        </div>
        <div className={`connection connection-${socketState}`} role="status">
          {socketState === "open" ? <Wifi size={14} /> : socketState === "connecting" ? <LoaderCircle className="spin" size={14} /> : <WifiOff size={14} />}
          {socketState === "open" ? "engine ready" : socketState === "connecting" ? "waking up" : "engine offline"}
        </div>
      </header>

      <main>
        {phase === "setup" && (
          <section className="setup-view page-enter">
            <div className="hero">
              <div className="eyebrow"><span className="live-dot" /> BENCHMARKS, BUT MAKE IT A RACE</div>
              <h1>Pick your ponies.<br /><em>Let the tokens fly.</em></h1>
              <p>Same prompt. Same starting gun. Your local coding models sprint side by side while we clock first token and streaming speed.</p>
              <div className="hero-stats">
                <span><Zap size={15} /> tokens / sec</span>
                <span><Clock3 size={15} /> first-token time</span>
                <span><Terminal size={15} /> your local agents</span>
              </div>
              <div className="hero-track" aria-hidden="true">
                <span style={{ "--track-color": "#cba6f7", "--track-offset": "13%" } as React.CSSProperties}><i /></span>
                <span style={{ "--track-color": "#94e2d5", "--track-offset": "48%" } as React.CSSProperties}><i /></span>
                <span style={{ "--track-color": "#f9e2af", "--track-offset": "72%" } as React.CSSProperties}><i /></span>
              </div>
            </div>

            <div className="setup-panel panel">
              <div className="panel-heading">
                <div><span className="step">01</span><h2>Build the starting grid</h2></div>
                <span className="count">{competitors.length} of 6 lanes filled</span>
              </div>

              {providersLoading ? (
                <div className="empty-state"><LoaderCircle className="spin" /><strong>Scanning local agents…</strong><span>Checking installed harnesses and models</span></div>
              ) : providersError ? (
                <div className="empty-state error-state"><AlertCircle /><strong>Agent scan failed</strong><span>{providersError}</span><button className="text-button" onClick={() => void loadProviders()}>Try again</button></div>
              ) : (
                <div className="competitor-list">
                  {competitors.map((competitor, index) => {
                    const provider = providerMap.get(competitor.harness);
                    return (
                      <article className="competitor-card" key={competitor.id} style={{ "--lane-color": competitor.color } as React.CSSProperties}>
                        <div className="grid-position">{String(index + 1).padStart(2, "0")}</div>
                        <div className="field harness-field">
                          <label>Harness</label>
                          <HarnessPicker
                            providers={installedProviders}
                            value={competitor.harness}
                            renderIcon={(candidate) => <HarnessMark harness={candidate.id} />}
                            onChange={(candidate) => updateHarness(competitor.id, candidate.id)}
                          />
                        </div>
                        <div className="field model-field">
                          <label>Model</label>
                          <ModelPicker
                            models={provider?.models ?? []}
                            value={competitor.model}
                            providerName={provider?.name ?? HARNESS_LABELS[competitor.harness]}
                            providerIcon={<HarnessMark harness={competitor.harness} />}
                            onChange={(model) => updateModel(competitor.id, model)}
                          />
                        </div>
                        <div className="field label-field">
                          <label>Race label</label>
                          <input value={competitor.label} maxLength={32} onChange={(event) => updateCompetitor(competitor.id, { label: event.target.value })} placeholder="Display name" />
                        </div>
                        <button className="icon-button remove-button" onClick={() => removeCompetitor(competitor.id)} disabled={competitors.length <= 2} aria-label={`Remove ${competitor.label}`}><Minus size={17} /></button>
                      </article>
                    );
                  })}
                  {competitors.length < 6 && <button className="add-competitor" onClick={addCompetitor}><Plus size={17} /> Add another lane</button>}
                </div>
              )}

              <div className="race-options">
                <div className="option-group">
                  <label className="option-label"><span className="step">02</span> Starting style</label>
                  <div className="segmented">
                    <button aria-pressed={mode === "parallel"} className={mode === "parallel" ? "active" : ""} onClick={() => setMode("parallel")}><Activity size={16} /><span><b>Same gun</b><small>Launch together</small></span></button>
                    <button aria-pressed={mode === "sequential"} className={mode === "sequential" ? "active" : ""} onClick={() => setMode("sequential")}><ChevronRight size={16} /><span><b>Time trial</b><small>One at a time</small></span></button>
                  </div>
                </div>
                <div className="option-group">
                  <label className="option-label"><span className="step">03</span> How serious?</label>
                  <div className="preset-grid">
                    {PRESETS.map((option) => (
                      <button key={option.id} aria-pressed={preset === option.id} className={preset === option.id ? "active" : ""} onClick={() => setPreset(option.id)}>
                        <span className="radio-mark">{preset === option.id && <span />}</span>
                        <span><b>{option.label}</b><small>{option.detail}</small></span>
                        <em>{option.runs}</em>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {!canReview && !providersLoading && competitors.length > 0 && (
                <div className="inline-warning" role="alert"><AlertCircle size={15} /> Every racer needs an installed, authenticated harness, model, and label.</div>
              )}
              <div className="panel-footer">
                <p><Radio size={14} /> The stopwatch lives here. Only your normal model traffic leaves the machine.</p>
                <button className="primary-button" disabled={!canReview || socketState !== "open"} onClick={() => setPhase("review")}>Head to the pits <ChevronRight size={18} /></button>
              </div>
            </div>
          </section>
        )}

        {phase === "review" && (
          <section className="review-view narrow-view page-enter">
            <button className="back-button" onClick={() => setPhase("setup")}><ArrowLeft size={16} /> Edit starting grid</button>
            <div className="section-intro">
              <div>
                <div className="eyebrow"><Flag size={14} /> PIT CHECK</div>
                <h1>Last look before lights out.</h1>
                <p>These runs use your normal model quota. Make sure every lane looks right.</p>
              </div>
              <div className="starting-lights" aria-hidden="true"><span /><span /><span /></div>
            </div>
            <div className="review-grid panel">
              <div className="review-meta">
                <div><span>START</span><strong>{mode === "parallel" ? "Same gun" : "Time trial"}</strong></div>
                <div><span>DISTANCE</span><strong>{PRESETS.find((item) => item.id === preset)?.label}</strong></div>
                <div><span>TRACKS</span><strong>Prose + TypeScript</strong></div>
              </div>
              <div className="review-racers">
                {competitors.map((competitor, index) => (
                  <div key={competitor.id} className="review-racer" style={{ "--lane-color": competitor.color } as React.CSSProperties}>
                    <span className="review-number">{index + 1}</span>
                    <HarnessMark harness={competitor.harness} />
                    <div><strong>{competitor.label}</strong><span>{HARNESS_LABELS[competitor.harness]} · {competitor.model}</span></div>
                    <Check size={17} />
                  </div>
                ))}
              </div>
              {notice && <div className="inline-warning"><AlertCircle size={15} /> {notice}</div>}
              <button className="launch-button" onClick={startRace} disabled={socketState !== "open"}>
                <span><Play size={21} fill="currentColor" /></span>
                <div><b>LIGHTS OUT</b><small>Start the live benchmark</small></div>
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
                  <span className={activeWorkload === "prose" ? "active" : activeWorkload === "code" ? "done" : ""}><span>01</span> Prose</span>
                  <i />
                  <span className={activeWorkload === "code" ? "active" : ""}><span>02</span> TypeScript</span>
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
                const elapsedSetup = lane.status === "starting" && lane.setupStartedAt ? now - lane.setupStartedAt : lane.setupMs;
                const elapsedTtft = lane.status === "running" && lane.ttftMs === undefined && lane.runningStartedAt ? now - lane.runningStartedAt : lane.ttftMs;
                const laneProgress = Math.min(100, (lane.completedRuns / expectedPerLane) * 100);
                return (
                  <article className={`race-lane status-${lane.status}`} key={competitor.id} style={{ "--lane-color": competitor.color } as React.CSSProperties}>
                    <div className="lane-stripe" />
                    <div className="lane-head">
                      <span className="lane-position">P{index + 1}</span>
                      <HarnessMark harness={competitor.harness} />
                      <div className="lane-identity"><strong>{competitor.label}</strong><span>{competitor.model}</span></div>
                      <div className="lane-status">
                        {lane.status === "running" ? <><span className="live-dot" /> STREAMING</> : lane.status === "starting" || lane.status === "ready" || lane.status === "queued" ? <><LoaderCircle className="spin" size={13} /> {lane.status.toUpperCase()}</> : lane.status === "error" ? <><AlertCircle size={13} /> ERROR</> : <><Check size={13} /> HEAT DONE</>}
                      </div>
                    </div>
                    <div className="lane-metrics">
                      <Metric label="SETUP" value={formatMs(elapsedSetup)} />
                      <Metric label="TTFT" value={formatMs(elapsedTtft)} accent={lane.ttftMs !== undefined} />
                      <Metric label="LIVE TPS" value={formatTps(lane.liveTps)} accent={lane.liveTps !== undefined} />
                    </div>
                    <div className="stream-window">
                      <div className="stream-toolbar">
                        <span><Code2 size={13} /> {lane.workload === "code" ? "typescript.ts" : lane.workload === "prose" ? "prose.txt" : "awaiting-stream"}</span>
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
                <p>Median result across valid prose and TypeScript runs.</p>
              </div>
              <div className="checker-strip" aria-hidden="true" />
            </div>

            {winner ? (
              <>
                <div className="finish-deck">
                  <article className="winner-card" style={{ "--lane-color": winner.competitor.color } as React.CSSProperties}>
                    <div className="winner-kicker"><Trophy size={16} /> Fastest overall</div>
                    <div className="winner-identity">
                      <HarnessMark harness={winner.competitor.harness} />
                      <div><h2>{winner.competitor.label}</h2><span>{winner.competitor.model}</span></div>
                    </div>
                    <div className="winner-time"><strong>{formatMs(winner.totalMs)}</strong><span>median finish</span></div>
                    <div className="winner-metrics">
                      <span><small>TTFT</small><b>{formatMs(winner.modelTtftMs)}</b></span>
                      <span><small>TPS</small><b>{formatTps(winner.normalizedTps)}</b></span>
                      <span><small>MARGIN</small><b>{winningMargin === undefined ? "solo" : `−${formatMs(winningMargin)}`}</b></span>
                    </div>
                  </article>
                  <div className="runner-stack">
                    {summary.slice(1, 3).map((row) => (
                      <article className="runner-card" key={row.competitor.id} style={{ "--lane-color": row.competitor.color } as React.CSSProperties}>
                        <span className="runner-place">{ordinal(row.overallRank)}</span>
                        <HarnessMark harness={row.competitor.harness} />
                        <div><strong>{row.competitor.label}</strong><small>{row.competitor.model}</small></div>
                        <b>{formatMs(row.totalMs)}</b>
                      </article>
                    ))}
                  </div>
                </div>

                <div className="results-table panel">
                  <div className="table-title"><div><Flag size={18} /><h2>Full classification</h2></div><span>{results.filter((result) => result.valid && !result.warmup).length} valid runs</span></div>
                  <div className="table-scroll">
                    <table>
                      <caption>Complete benchmark results ranked by median total time</caption>
                      <thead><tr><th scope="col">Place</th><th scope="col">Racer</th><th scope="col">TTFT</th><th scope="col">Cold TTFT</th><th scope="col">TPS</th><th scope="col">Total</th><th scope="col">Runs</th></tr></thead>
                      <tbody>
                        {summary.map((row) => (
                          <tr key={row.competitor.id}>
                            <td><span className={`position-badge position-${row.overallRank}`}>{row.overallRank}</span></td>
                            <td><div className="table-racer"><span className="table-lane-swatch" style={{ background: row.competitor.color }} /><HarnessMark harness={row.competitor.harness} /><div><strong>{row.competitor.label}</strong><small>{row.competitor.model}</small></div></div></td>
                            <td className={row.crowns.includes("modelTtft") ? "crowned" : ""}>{formatMs(row.modelTtftMs)}{row.crowns.includes("modelTtft") && <span className="best-chip">best</span>}</td>
                            <td className={row.crowns.includes("coldTtft") ? "crowned" : ""}>{formatMs(row.coldTtftMs)}{row.crowns.includes("coldTtft") && <span className="best-chip">best</span>}</td>
                            <td className={row.crowns.includes("tps") ? "crowned" : ""}>{formatTps(row.normalizedTps)}{row.crowns.includes("tps") && <span className="best-chip">best</span>}</td>
                            <td className={row.crowns.includes("overall") ? "crowned" : ""}>{formatMs(row.totalMs)}{row.crowns.includes("overall") && <span className="best-chip">best</span>}</td>
                            <td><span className="run-count">{row.validRuns}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                {invalidResults.length > 0 && (
                  <details className="invalid-results panel">
                    <summary><span><AlertCircle size={15} /> {invalidResults.length} invalid {invalidResults.length === 1 ? "run" : "runs"} excluded</span><ChevronRight size={15} /></summary>
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
              </>
            ) : (
              <div className="empty-state panel"><AlertCircle /><strong>No valid finishers</strong><span>Review the run errors and try again.</span></div>
            )}

            <div className="results-actions">
              <button className="secondary-button" onClick={() => setPhase("setup")}><ArrowLeft size={16} /> Edit grid</button>
              <button className="primary-button" onClick={resetRace}><RotateCcw size={16} /> Race again</button>
            </div>
          </section>
        )}
      </main>

      <footer><span>TPS RACER</span><p>Local benchmark · normalized visible tokens · lower TTFT is better</p></footer>
    </div>
  );
}
