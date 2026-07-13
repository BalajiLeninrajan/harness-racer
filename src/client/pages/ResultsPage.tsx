import { AlertCircle, ArrowLeft, ChevronRight, Flag, RotateCcw } from "lucide-react";
import type { CSSProperties } from "react";
import type { Competitor, RunResult, SummaryRow } from "../../shared/types";
import { formatMs, formatVisibleRate, ordinal } from "../benchmark";
import { ModelMark } from "../components/BenchmarkPrimitives";

interface ResultsPageProps {
  competitors: Competitor[];
  results: RunResult[];
  summary: SummaryRow[];
  onEditGrid: () => void;
  onRaceAgain: () => void;
}

export function ResultsPage({ competitors, results, summary, onEditGrid, onRaceAgain }: ResultsPageProps) {
  const invalidResults = results.filter((result) => !result.valid && !result.warmup);
  const eligibleSummary = summary.filter((row) => !row.disqualified);

  return (
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
              <li className={`podium-entry rank-${row.finishRank}`} key={row.competitor.id} style={{ "--lane-color": row.competitor.color } as CSSProperties}>
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
        <button className="secondary-button" onClick={onEditGrid}><ArrowLeft size={16} /> Edit grid</button>
        <button className="primary-button" onClick={onRaceAgain}><RotateCcw size={16} /> Race again</button>
      </div>
    </section>
  );
}
