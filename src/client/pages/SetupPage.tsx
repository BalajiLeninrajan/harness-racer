import { AlertCircle, ChevronRight, Flag, LoaderCircle, Minus, Plus } from "lucide-react";
import type { CSSProperties } from "react";
import type { Competitor, ProviderInfo } from "../../shared/types";
import { RacerPicker, type RacerChoice } from "../RacerPicker";

interface SetupPageProps {
  competitors: Competitor[];
  providers: ProviderInfo[];
  providersLoading: boolean;
  providersError?: string;
  canReview: boolean;
  engineReady: boolean;
  onRetryProviders: () => void;
  onSelectionChange: (id: string, choice: RacerChoice) => void;
  onAddCompetitor: () => void;
  onRemoveCompetitor: (id: string) => void;
  onContinue: () => void;
}

export function SetupPage({
  competitors,
  providers,
  providersLoading,
  providersError,
  canReview,
  engineReady,
  onRetryProviders,
  onSelectionChange,
  onAddCompetitor,
  onRemoveCompetitor,
  onContinue,
}: SetupPageProps) {
  return (
    <section className="page-main is-reading page-enter">
      <div className="panel is-shell">
        <header className="setup-intro panel-body cn-row cn-top cn-between cn-gap-28">
          <div>
            <div className="eyebrow"><Flag size={14} /> STARTING LINEUP</div>
            <h1 className="cn-display-sm cn-m-0">Choose your racers.</h1>
          </div>
          <span className="setup-count cn-fixed" aria-label={`${competitors.length} of 6 models selected`}>{competitors.length} <small>/ 6</small></span>
        </header>

        <div className="setup-content cn-px-22">
          {providersLoading ? (
            <div className="empty-state"><LoaderCircle className="spin" /><strong>Scanning local agents…</strong><span>Checking installed harnesses and models</span></div>
          ) : providersError ? (
            <div className="empty-state"><AlertCircle /><strong>Agent scan failed</strong><span>{providersError}</span><button className="btn-text" onClick={onRetryProviders}>Try again</button></div>
          ) : (
            <div className="well cn-bg-well cn-p-8">
              <div className="cn-divide">
                {competitors.map((competitor) => (
                  <div className="competitor-card cn-spine" key={competitor.id} style={{ "--accent": competitor.color } as CSSProperties}>
                    <RacerPicker providers={providers} harness={competitor.harness} model={competitor.model} onChange={(choice) => onSelectionChange(competitor.id, choice)} />
                    <button
                      className={`btn-icon cn-tone-red remove-button${competitors.length <= 2 ? " is-hidden" : ""}`}
                      onClick={() => onRemoveCompetitor(competitor.id)}
                      disabled={competitors.length <= 2}
                      aria-hidden={competitors.length <= 2 ? true : undefined}
                      tabIndex={competitors.length <= 2 ? -1 : undefined}
                      aria-label={`Remove ${competitor.label}`}
                    ><Minus size={17} /></button>
                  </div>
                ))}
              </div>
              {competitors.length < 6 && <button key="add-model" className="btn-dashed cn-w-full cn-mt-8" onClick={onAddCompetitor}><Plus size={17} /> Add model</button>}
            </div>
          )}

          {!canReview && !providersLoading && competitors.length > 0 && (
            <div className="banner cn-tone-peach cn-mt-12" role="alert"><AlertCircle size={15} /> Choose at least two available models.</div>
          )}
        </div>

        <div className="setup-actions panel-body">
          <button className="btn btn-primary cn-w-full" disabled={!canReview || !engineReady} onClick={onContinue}>Set up race <ChevronRight size={18} /></button>
        </div>
      </div>
    </section>
  );
}
