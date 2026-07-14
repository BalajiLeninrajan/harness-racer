import { Activity, AlertCircle, ArrowLeft, ChevronRight, Flag, Play } from "lucide-react";
import type { CSSProperties } from "react";
import type { Competitor, ProviderInfo, RunMode, SamplePreset } from "../../shared/types";
import { modelLabName } from "../BrandLogo";
import { HARNESS_LABELS, PRESETS } from "../benchmark";
import { ModelMark } from "../components/BenchmarkPrimitives";

interface ReviewPageProps {
  competitors: Competitor[];
  providers: ProviderInfo[];
  mode: RunMode;
  preset: SamplePreset;
  notice?: string;
  canStart: boolean;
  engineReady: boolean;
  onEditModels: () => void;
  onModeChange: (mode: RunMode) => void;
  onPresetChange: (preset: SamplePreset) => void;
  onCompetitorNameChange: (id: string, label: string) => void;
  onStart: () => void;
}

export function ReviewPage({ competitors, providers, mode, preset, notice, canStart, engineReady, onEditModels, onModeChange, onPresetChange, onCompetitorNameChange, onStart }: ReviewPageProps) {
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));

  return (
    <section className="review-view narrow-view page-enter">
      <button className="back-button" onClick={onEditModels}><ArrowLeft size={16} /> Edit models</button>
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
              <button aria-pressed={mode === "parallel"} className={mode === "parallel" ? "active" : ""} onClick={() => onModeChange("parallel")}><Activity size={16} /><span><b>Parallel</b><small>Start together; may compete for resources</small></span></button>
              <button aria-pressed={mode === "sequential"} className={mode === "sequential" ? "active" : ""} onClick={() => onModeChange("sequential")}><ChevronRight size={16} /><span><b>Sequential</b><small>One at a time; reduces contention</small></span></button>
            </div>
          </div>
          <div className="option-group">
            <label className="option-label">Samples</label>
            <div className="preset-grid">
              {PRESETS.map((option) => (
                <button key={option.id} aria-pressed={preset === option.id} className={preset === option.id ? "active" : ""} onClick={() => onPresetChange(option.id)}>
                  <span className="radio-mark">{preset === option.id && <span />}</span>
                  <span><b>{option.label}</b><small>{option.runs}</small></span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="review-racers">
          {competitors.map((competitor, index) => (
            <div key={competitor.id} className="review-racer" style={{ "--lane-color": competitor.color } as CSSProperties}>
              <span className="review-number">{index + 1}</span>
              <ModelMark harness={competitor.harness} model={competitor.model} />
              <div className="review-racer-model"><strong>{providerMap.get(competitor.harness)?.models.find((model) => model.id === competitor.model)?.label ?? competitor.model}</strong><span>{modelLabName(competitor.model, competitor.harness)} · via {HARNESS_LABELS[competitor.harness]}</span></div>
              <label className="review-name"><span>Race name</span><input value={competitor.label} maxLength={32} onChange={(event) => onCompetitorNameChange(competitor.id, event.target.value)} placeholder="Name this racer" /></label>
            </div>
          ))}
        </div>
        {notice && <div className="inline-warning"><AlertCircle size={15} /> {notice}</div>}
        <button className="launch-button" onClick={onStart} disabled={!canStart || !engineReady}>
          <span><Play size={21} fill="currentColor" /></span>
          <div><b>Start race</b><small>Run the benchmark</small></div>
          <ChevronRight size={21} />
        </button>
      </div>
    </section>
  );
}
