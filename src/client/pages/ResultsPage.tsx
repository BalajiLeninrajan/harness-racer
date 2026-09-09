import { AlertCircle, ArrowLeft, Flag, RotateCcw } from "lucide-react";
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
    <section className="page-main page-enter" style={{ "--page-width": "1120px" } as CSSProperties}>
      <div className="cn-mb-22">
        <div>
          <div className="eyebrow"><Flag size={14} /> CHECKERED FLAG</div>
          <h1 className="cn-display cn-m-0">Photo finish.</h1>
          <p className="cn-copy cn-mt-12 cn-mb-0">Median harness + model result across valid paper and Python runs.</p>
        </div>
      </div>

      {eligibleSummary.length >= 3 && (
        <div className="podium-showcase well cn-mb-16">
          <ol className="podium-grid cn-list-none" aria-label="Top three finishers">
            {eligibleSummary.slice(0, 3).map((row) => (
              <li className={`podium-entry rank-${row.finishRank}`} key={row.competitor.id} style={{ "--accent": row.competitor.color } as CSSProperties}>
                <div className="podium-identity cn-text-center">
                  <span className="cn-microlabel cn-text-accent">{ordinal(row.finishRank)}</span>
                  <ModelMark harness={row.competitor.harness} model={row.competitor.model} />
                  <strong className="cn-w-full cn-truncate">{row.competitor.label}</strong>
                  <small className="cn-w-full cn-code-meta cn-truncate">{row.competitor.model}</small>
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
          <div className="panel-heading table-title"><div className="cn-row cn-text-mauve"><Flag size={18} /><h2>Full classification</h2></div><span className="cn-meta">{results.filter((result) => result.valid && !result.warmup).length} valid runs{summary.some((row) => row.disqualified) ? ` · ${summary.filter((row) => row.disqualified).length} DSQ` : ""}</span></div>
          <div className="table-scroll">
            <table className="table-neu">
              <caption className="cn-sr-only">Harness and model stacks with disqualified racers listed after ranked finishers</caption>
              <thead><tr><th scope="col">Place</th><th scope="col">Harness + model</th><th scope="col">Prompt → first</th><th scope="col">Cold start → first</th><th scope="col">Visible tok/s</th><th scope="col">Prompt → finish</th><th scope="col">Runs</th></tr></thead>
              <tbody>
                {summary.map((row) => (
                  <tr className={row.disqualified ? "disqualified" : row.anomalousRuns > 0 ? "has-anomalies" : undefined} key={row.competitor.id}>
                    <td><span className={`position-badge ${row.disqualified ? "position-dsq" : `position-${row.finishRank}`}`}>{row.disqualified ? "DSQ" : row.finishRank}</span></td>
                    <td><div className="table-racer cn-row"><span className="table-lane-swatch" style={{ background: row.competitor.color }} /><ModelMark harness={row.competitor.harness} model={row.competitor.model} /><div className="cell-name cn-grow cn-stack cn-gap-4"><strong className="cn-truncate">{row.competitor.label}</strong><small className="cn-code-meta cn-truncate">{row.competitor.model}</small>{row.anomalousRuns > 0 && <span className={`chip-tone cn-fit ${row.disqualified ? "cn-tone-red" : "cn-tone-peach"}`}>{row.disqualified ? "all runs anomalous" : `${row.anomalousRuns} anomalous ${row.anomalousRuns === 1 ? "run" : "runs"}`}</span>}</div></div></td>
                    <td data-label="PROMPT → FIRST" className={row.crowns.includes("firstOutput") ? "crowned" : ""}>{formatMs(row.promptToFirstOutputMs)}{row.crowns.includes("firstOutput") && <span className="best-chip">best</span>}</td>
                    <td data-label="COLD → FIRST" className={row.crowns.includes("coldStart") ? "crowned" : ""}>{formatMs(row.coldStartToFirstOutputMs)}{row.crowns.includes("coldStart") && <span className="best-chip">best</span>}</td>
                    <td data-label="VISIBLE TOK/S" className={row.crowns.includes("visibleSpeed") ? "crowned" : ""}>{formatVisibleRate(row.visibleTokensPerSecond)}{row.crowns.includes("visibleSpeed") && <span className="best-chip">best</span>}</td>
                    <td data-label="PROMPT → FINISH" className={row.crowns.includes("finish") ? "crowned" : ""}>{formatMs(row.promptToFinishMs)}{row.crowns.includes("finish") && <span className="best-chip">best</span>}</td>
                    <td data-label="RUNS"><span className="well cn-bg-well cn-r-mark cn-p-4 cn-px-8">{row.anomalousRuns > 0 ? `${row.validRuns}/${row.measuredRuns}` : row.measuredRuns}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {invalidResults.length > 0 && (
        <div className="accordion invalid-results cn-mt-12">
          {/* The recipe's checkbox loses the disclosure's native Enter, so the
              label restores it; Space still toggles the input natively. */}
          <label onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).click(); }}>
            <input type="checkbox" />
            <span className="cn-row"><AlertCircle size={15} className="cn-text-peach" /> {invalidResults.length} {invalidResults.length === 1 ? "run anomaly" : "run anomalies"}</span>
          </label>
          <div className="fold">
            <div className="cn-divide">
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
          </div>
        </div>
      )}

      <div className="results-actions cn-row cn-center cn-mt-22">
        <button className="btn btn-secondary" onClick={onEditGrid}><ArrowLeft /> Edit grid</button>
        <button className="btn btn-primary" onClick={onRaceAgain}><RotateCcw /> Race again</button>
      </div>
    </section>
  );
}
