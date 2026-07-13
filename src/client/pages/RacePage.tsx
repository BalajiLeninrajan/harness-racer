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
  const activeWorkload = Object.values(lanes).find((lane) => lane.status === "running" || lane.status === "starting")?.workload;

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
          <button className="cancel-button" onClick={onCancel}><CircleStop size={15} /> Cancel</button>
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
            <article className={`race-lane status-${lane.status}`} key={competitor.id} style={{ "--lane-color": competitor.color } as CSSProperties}>
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
                  <span><Code2 size={13} /> {workloadFilename(lane.workload)}</span>
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
  );
}

function workloadFilename(workload?: WorkloadId) {
  if (workload === "code") return "model.py";
  if (workload === "prose") return "attention.txt";
  return "awaiting-stream";
}
