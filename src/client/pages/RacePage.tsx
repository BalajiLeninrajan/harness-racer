import { AlertCircle, Check, CircleStop, Code2, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Competitor, WorkloadId } from "../../shared/types";
import { emptyLane, formatMs, formatVisibleRate, type LaneState } from "../benchmark";
import { Metric, ModelMark } from "../components/BenchmarkPrimitives";

interface RacePageProps {
  competitors: Competitor[];
  lanes: Record<string, LaneState>;
  totalRuns: number;
  completedRuns: number;
  notice?: string;
  onCancel: () => void;
}

export function RacePage({ competitors, lanes, totalRuns, completedRuns, notice, onCancel }: RacePageProps) {
  const [now, setNow] = useState(() => performance.now());
  const raceRef = useRef<HTMLElement | null>(null);
  const streamRefs = useRef<Record<string, HTMLPreElement | null>>({});
  const expectedPerLane = totalRuns ? Math.ceil(totalRuns / Math.max(competitors.length, 1)) : 1;
  // Taken in grid order so the leading lane keys the overall bar when several
  // race in parallel; undefined between heats, which falls back to the
  // package's default accent fill.
  const activeCompetitor = competitors.find((competitor) => lanes[competitor.id]?.status === "running" || lanes[competitor.id]?.status === "starting");
  const activeWorkload = activeCompetitor ? lanes[activeCompetitor.id]?.workload : undefined;

  useEffect(() => {
    raceRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    for (const [competitorId, stream] of Object.entries(streamRefs.current)) {
      if (!stream || lanes[competitorId]?.status !== "running") continue;
      const distanceFromBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
      if (distanceFromBottom < 56) stream.scrollTop = stream.scrollHeight;
    }
  }, [lanes]);

  return (
    <section className="race-view page-main page-enter" ref={raceRef}>
      <div className="race-header cn-row cn-between cn-gap-32 cn-mb-24">
        <h1 className="cn-display">They’re off.</h1>
        <div className="race-header-right cn-row cn-gap-16">
          <div className="stepper heat-switcher" aria-label="Test texts">
            <span className={activeWorkload === "prose" ? "active" : activeWorkload === "code" ? "is-done" : ""}><i>01</i>Attention paper</span>
            <span className={activeWorkload === "code" ? "active" : ""}><i>02</i>nanoGPT attention</span>
          </div>
          <button className="btn btn-secondary is-sm" onClick={onCancel}><CircleStop /> Cancel</button>
        </div>
      </div>

      <div className="cn-mb-16" role="progressbar" aria-label="Benchmark progress" aria-valuemin={0} aria-valuemax={totalRuns || 1} aria-valuenow={completedRuns}>
        <div className="cn-row cn-between cn-mb-8 cn-meta"><span>{completedRuns} / {totalRuns || "…"} runs complete</span><span>{totalRuns ? Math.round((completedRuns / totalRuns) * 100) : 0}%</span></div>
        <div className="progress-track" style={activeCompetitor ? { "--progress-fill": activeCompetitor.color } as CSSProperties : undefined}><span style={{ width: `${totalRuns ? Math.min(100, (completedRuns / totalRuns) * 100) : 2}%` }} /></div>
      </div>

      <div className="race-lanes">
        {competitors.map((competitor, index) => {
          const lane = lanes[competitor.id] ?? emptyLane();
          const elapsedHarnessPrep = lane.status === "starting" && lane.setupStartedAt ? now - lane.setupStartedAt : lane.harnessPrepMs;
          const elapsedFirstOutput = lane.status === "running" && lane.firstOutputMs === undefined && lane.runningStartedAt ? now - lane.runningStartedAt : lane.firstOutputMs;
          const laneProgress = Math.min(100, (lane.completedRuns / expectedPerLane) * 100);
          return (
            <article className={`panel race-lane status-${lane.status}`} key={competitor.id} style={{ "--accent": competitor.color } as CSSProperties}>
              <div className="lane-head cn-row cn-gap-12">
                <ModelMark harness={competitor.harness} model={competitor.model} />
                <div className="lane-identity cn-grow cn-stack cn-gap-4"><strong className="cn-name">{competitor.label}</strong><span className="cn-code-meta cn-truncate">{competitor.model}</span></div>
                <div className="cn-row cn-microlabel cn-nowrap">
                  <span className="cn-text-overlay-0">P{index + 1}</span>
                  <span className={`cn-row cn-gap-4 ${lane.status === "running" ? "cn-text-accent" : lane.status === "complete" ? "cn-text-green" : lane.status === "error" ? "cn-text-red" : ""}`}>
                    {lane.status === "running" ? <><span className="live-dot" /> Streaming</> : lane.status === "starting" || lane.status === "ready" || lane.status === "queued" ? <><LoaderCircle className="spin" size={13} /> {STATUS_LABELS[lane.status]}</> : lane.status === "error" ? <><AlertCircle size={13} /> Error</> : <><Check size={13} /> Heat done</>}
                  </span>
                </div>
              </div>
              <div className="lane-metrics">
                <Metric label="Visible tok/s" value={formatVisibleRate(lane.liveVisibleTokensPerSecond)} accent={lane.liveVisibleTokensPerSecond !== undefined} hero />
                <Metric label="First output" value={formatMs(elapsedFirstOutput)} />
                <Metric label="Harness prep" value={formatMs(elapsedHarnessPrep)} />
              </div>
              <div className="terminal stream-window">
                <div className="stream-toolbar cn-row cn-between cn-meta">
                  <span className="cn-row cn-code-meta"><Code2 size={13} /> {workloadFilename(lane.workload)}</span>
                  <span>{lane.warmup ? "Warmup" : lane.sample !== undefined ? `Sample ${lane.sample}` : "Queued"}</span>
                </div>
                <pre ref={(element) => { streamRefs.current[competitor.id] = element; }}>{lane.output || (lane.status === "error" ? lane.error : "Waiting for the green light…")}<span className={lane.status === "running" ? "caret" : "caret hidden"} /></pre>
              </div>
              {lane.error && <div className="cn-row cn-meta cn-text-red"><AlertCircle size={13} /> {lane.error}</div>}
              <div className="progress-track"><span style={{ width: `${laneProgress}%` }} /></div>
            </article>
          );
        })}
      </div>
      {notice && <div className="banner cn-tone-peach cn-mt-12"><AlertCircle size={15} /> {notice}</div>}
    </section>
  );
}

const STATUS_LABELS = { starting: "Starting", ready: "Ready", queued: "Queued" } as const;

function workloadFilename(workload?: WorkloadId) {
  if (workload === "code") return "model.py";
  if (workload === "prose") return "attention.txt";
  return "awaiting-stream";
}
