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
    <section className="page-main page-enter" style={{ "--page-width": "980px" } as CSSProperties}>
      <button className="btn btn-ghost is-sm cn-mb-22" onClick={onEditModels}><ArrowLeft /> Edit models</button>
      <div className="section-intro cn-row cn-between cn-gap-28 cn-mb-22">
        <div>
          <div className="eyebrow"><Flag size={14} /> STARTING GRID</div>
          <h1 className="cn-display cn-m-0">Name your racers.</h1>
          <p className="cn-copy cn-mt-12 cn-mb-0">Confirm the lineup, then start the benchmark.</p>
        </div>
        <div className="starting-lights" aria-hidden="true"><span /><span /><span /></div>
      </div>
      <div className="panel cn-stack cn-p-8">
        <div className="race-options well cn-bg-well cn-p-16">
          <div className="cn-stack cn-gap-8">
            <label className="option-label">Run order</label>
            <div className="segmented">
              <button aria-pressed={mode === "parallel"} onClick={() => onModeChange("parallel")}><Activity /><span className="cn-min-0 cn-stack cn-gap-4"><b>Parallel</b><small className="cn-truncate">Start together; may compete for resources</small></span></button>
              <button aria-pressed={mode === "sequential"} onClick={() => onModeChange("sequential")}><ChevronRight /><span className="cn-min-0 cn-stack cn-gap-4"><b>Sequential</b><small className="cn-truncate">One at a time; reduces contention</small></span></button>
            </div>
          </div>
          <div className="cn-stack cn-gap-8">
            <label className="option-label">Samples</label>
            <div className="segmented">
              {PRESETS.map((option) => (
                <button key={option.id} aria-pressed={preset === option.id} onClick={() => onPresetChange(option.id)}>
                  <span className="radio-mark">{preset === option.id && <span />}</span>
                  <span className="cn-min-0 cn-stack cn-gap-4"><b>{option.label}</b><small className="cn-truncate">{option.runs}</small></span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="well cn-bg-well cn-p-8 cn-divide">
          {competitors.map((competitor, index) => (
            <div key={competitor.id} className="review-racer cn-spine" style={{ "--accent": competitor.color } as CSSProperties}>
              <span className="mark-solid">{index + 1}</span>
              <ModelMark harness={competitor.harness} model={competitor.model} />
              <div className="review-racer-model cn-min-0 cn-stack cn-gap-4"><strong className="cn-truncate">{providerMap.get(competitor.harness)?.models.find((model) => model.id === competitor.model)?.label ?? competitor.model}</strong><span className="cn-code-meta cn-truncate">{modelLabName(competitor.model, competitor.harness)} · via {HARNESS_LABELS[competitor.harness]}</span></div>
              <label className="review-name cn-stack cn-gap-8"><span className="cn-microlabel">Race name</span><input className="input" value={competitor.label} maxLength={32} onChange={(event) => onCompetitorNameChange(competitor.id, event.target.value)} placeholder="Name this racer" /></label>
            </div>
          ))}
        </div>
        {notice && <div className="banner cn-tone-peach"><AlertCircle size={15} /> {notice}</div>}
        <button className="btn btn-secondary is-lg launch-button" onClick={onStart} disabled={!canStart || !engineReady}>
          <span><Play size={21} fill="currentColor" /></span>
          <div className="cn-grow cn-stack cn-gap-4"><b>Start race</b><small>Run the benchmark</small></div>
          <ChevronRight />
        </button>
      </div>
    </section>
  );
}
