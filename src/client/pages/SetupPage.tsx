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
            <div className="empty-state error-state"><AlertCircle /><strong>Agent scan failed</strong><span>{providersError}</span><button className="text-button" onClick={onRetryProviders}>Try again</button></div>
          ) : (
            <div className="competitor-list">
              {competitors.map((competitor) => (
                <div className="competitor-card" key={competitor.id} style={{ "--lane-color": competitor.color } as CSSProperties}>
                  <RacerPicker providers={providers} harness={competitor.harness} model={competitor.model} onChange={(choice) => onSelectionChange(competitor.id, choice)} />
                  <button
                    className={`icon-button remove-button${competitors.length <= 2 ? " is-hidden" : ""}`}
                    onClick={() => onRemoveCompetitor(competitor.id)}
                    disabled={competitors.length <= 2}
                    aria-hidden={competitors.length <= 2 ? true : undefined}
                    tabIndex={competitors.length <= 2 ? -1 : undefined}
                    aria-label={`Remove ${competitor.label}`}
                  ><Minus size={17} /></button>
                </div>
              ))}
              {competitors.length < 6 && <button key="add-model" className="add-competitor" onClick={onAddCompetitor}><Plus size={17} /> Add model</button>}
            </div>
          )}

          {!canReview && !providersLoading && competitors.length > 0 && (
            <div className="inline-warning" role="alert"><AlertCircle size={15} /> Choose at least two available models.</div>
          )}
        </div>

        <div className="setup-actions">
          <button className="primary-button" disabled={!canReview || !engineReady} onClick={onContinue}>Set up race <ChevronRight size={18} /></button>
        </div>
      </div>
    </section>
  );
}
