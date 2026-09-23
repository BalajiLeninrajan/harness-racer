import { ArrowLeft, RotateCcw } from "lucide-react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { Competitor, RunResult, SummaryRow } from "../../shared/types";
import { ModelLabLogo } from "../BrandLogo";
import { formatMs, formatVisibleRate } from "../benchmark";
import { finishAxis, harnessLabel, summarySentences } from "../results";

interface ResultsPageProps {
  competitors: Competitor[];
  results: RunResult[];
  summary: SummaryRow[];
  onEditGrid: () => void;
  onRaceAgain: () => void;
}

const seconds = (ms: number) => ms / 1000;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/* The recipe's checkbox loses the disclosure's native Enter, so the label
   restores it; Space still toggles the input natively. */
const enterToggles = (event: KeyboardEvent) => {
  if (event.key === "Enter") (event.target as HTMLInputElement).click();
};

function Headline({ ranked }: { ranked: SummaryRow[] }) {
  const [winner, runnerUp] = ranked;
  if (!winner) return <h1 className="cn-display">No stack finished a valid run.</h1>;
  // Non-breaking hyphens keep a model id like GPT-5.6-Terra on one line.
  const name = `${harnessLabel(winner)} with ${winner.competitor.label.replaceAll("-", "\u2011")}`;
  if (!runnerUp) return <h1 className="cn-display">{name} is the only <em>finisher</em>.</h1>;
  return <h1 className="cn-display">{name} wins by <em>{formatMs(runnerUp.promptToFinishMs - winner.promptToFinishMs)}</em>.</h1>;
}

/* Photo finish: every stack on one time axis, with the winner's median as a
   chequered line through all the lanes. What runs past the line is how far
   behind that stack finished. */
function FinishChart({ ranked }: { ranked: SummaryRow[] }) {
  const { scaleMs, ticksMs } = finishAxis(Math.max(...ranked.map((row) => row.promptToFinishMs)));
  const [winner, runnerUp] = ranked;
  const chartVars = { "--scale": seconds(scaleMs), "--finish": seconds(winner.promptToFinishMs) } as CSSProperties;

  return (
    <section className="panel" aria-labelledby="finish-title">
      <header className="panel-header">
        <h2 id="finish-title">Prompt to finish</h2>
        <span className="cn-meta">median</span>
      </header>
      <div className="hr-chart" style={chartVars}>
        <ol className="cn-list-none cn-divide cn-m-0">
          {ranked.map((row) => (
            <li className="hr-lane" key={row.competitor.id} style={{ "--t": seconds(row.promptToFinishMs), "--accent": row.competitor.color } as CSSProperties}>
              <span className="cn-meta">{row.finishRank}</span>
              <span className="mark" aria-hidden="true"><ModelLabLogo harness={row.competitor.harness} model={row.competitor.model} size={16} /></span>
              <span className="hr-label cn-stack cn-gap-4 cn-min-0">
                <b className="cn-name cn-truncate">{row.competitor.label}</b>
                <span className="cn-meta cn-truncate">{harnessLabel(row)}{row.anomalousRuns > 0 && `, ${row.validRuns} of ${row.measuredRuns} runs valid`}</span>
              </span>
              <div className="hr-track">
                <div className="progress-track is-lg"><span /></div>
                {row === runnerUp && <div className="hr-gap" aria-hidden="true"><b>+{formatMs(row.promptToFinishMs - winner.promptToFinishMs)}</b></div>}
              </div>
              <strong className="hr-label cn-value">{formatMs(row.promptToFinishMs)}</strong>
            </li>
          ))}
        </ol>
        <span className="hr-finish" aria-hidden="true" />
      </div>
      <div className="hr-chart hr-axis cn-meta" style={chartVars} aria-hidden="true">
        {ticksMs.map((tick) => <span key={tick} style={{ "--at": seconds(tick) } as CSSProperties}>{tick === 0 ? "0s" : formatMs(tick).replace(/\.0+s$/, "s")}</span>)}
      </div>
    </section>
  );
}

/* The one tilted panel: the race in a few sentences and three numbers. */
function RaceSummary({ ranked, summary }: { ranked: SummaryRow[]; summary: SummaryRow[] }) {
  const winner = ranked[0];
  const last = ranked.at(-1) ?? winner;
  const validRuns = summary.reduce((total, row) => total + row.validRuns, 0);
  const measuredRuns = summary.reduce((total, row) => total + row.measuredRuns, 0);
  const sentences = summarySentences(ranked);
  return (
    <aside className="panel is-tilted" aria-labelledby="summary-title">
      <header className="panel-header"><h2 id="summary-title">Summary</h2></header>
      <div className="cn-divide">
        {sentences.length > 0 && (
          <div className="panel-body cn-stack cn-gap-12">
            {sentences.map((sentence) => <p className="cn-copy cn-m-0" key={sentence}>{sentence}</p>)}
          </div>
        )}
        <div className="panel-body cn-divide">
          <div className="stat is-inline"><span>Winning time</span><strong>{formatMs(winner.promptToFinishMs)}</strong></div>
          {ranked.length > 2 && <div className="stat is-inline"><span>First to last</span><strong>{formatMs(last.promptToFinishMs - winner.promptToFinishMs)}</strong></div>}
          <div className="stat is-inline"><span>Valid runs</span><strong>{validRuns} of {measuredRuns}</strong></div>
        </div>
      </div>
    </aside>
  );
}

export function ResultsPage({ competitors, results, summary, onEditGrid, onRaceAgain }: ResultsPageProps) {
  const invalidResults = results.filter((result) => !result.valid && !result.warmup);
  const ranked = summary.filter((row) => !row.disqualified);
  const disqualified = summary.length - ranked.length;
  const validRuns = results.filter((result) => result.valid && !result.warmup).length;
  const runsEach = Math.max(0, ...summary.map((row) => row.measuredRuns));
  const racerName = (id: string) => competitors.find((item) => item.id === id)?.label ?? "Unknown racer";
  const leftOutNames = [...new Set(invalidResults.map((result) => racerName(result.competitorId)))];

  return (
    <section className="page-main page-enter cn-stack cn-gap-32" style={{ "--page-width": "1120px" } as CSSProperties}>
      <header>
        <Headline ranked={ranked} />
        <p className="lede">Median prompt to finish over {plural(runsEach, "run")} per stack, split between the attention paper and nanoGPT's self-attention code.</p>
        <div className="cn-row">
          <button className="btn btn-secondary" onClick={onEditGrid}><ArrowLeft /> Edit grid</button>
          <button className="btn btn-primary" onClick={onRaceAgain}><RotateCcw /> Race again</button>
        </div>
      </header>

      {ranked.length > 0 && (
        <div className="hr-body">
          <FinishChart ranked={ranked} />
          <RaceSummary ranked={ranked} summary={summary} />
        </div>
      )}

      {summary.length > 0 && (
        <section className="panel" aria-label="Details">
          <div className="accordion-stack">
            <div className="accordion">
              <label onKeyDown={enterToggles}>
                <input type="checkbox" />
                <b>Full classification</b>
                <span className="cn-meta">{plural(summary.length, "stack")}, {plural(validRuns, "valid run")}{disqualified > 0 && `, ${disqualified} disqualified`}</span>
              </label>
              <div className="fold"><div>
                <table className="data-table">
                  <caption className="cn-sr-only">Every stack's medians in finishing order, with disqualified stacks last</caption>
                  <thead><tr><th scope="col">Place</th><th scope="col">Harness and model</th><th scope="col">Prompt to first</th><th scope="col">Cold start to first</th><th scope="col">Visible tok/s</th><th scope="col">Prompt to finish</th><th scope="col">Runs</th></tr></thead>
                  <tbody>
                    {summary.map((row) => (
                      <tr key={row.competitor.id}>
                        <td data-label="Place">{row.disqualified ? <span className="tag cn-tone-red">DSQ</span> : row.finishRank}</td>
                        <td><div className="cell-name cn-stack cn-gap-4"><strong>{row.competitor.label}</strong><small>{harnessLabel(row)}</small></div></td>
                        <td data-label="Prompt to first">{formatMs(row.promptToFirstOutputMs)}</td>
                        <td data-label="Cold start to first">{formatMs(row.coldStartToFirstOutputMs)}</td>
                        <td data-label="Visible tok/s">{formatVisibleRate(row.visibleTokensPerSecond)}</td>
                        <td data-label="Prompt to finish">{formatMs(row.promptToFinishMs)}</td>
                        <td data-label="Runs">{row.anomalousRuns > 0 ? `${row.validRuns}/${row.measuredRuns}` : row.measuredRuns}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div></div>
            </div>
            {invalidResults.length > 0 && (
              <div className="accordion">
                <label onKeyDown={enterToggles}>
                  <input type="checkbox" />
                  <b>{plural(invalidResults.length, "run")} left out</b>
                  <span className="cn-meta cn-truncate">{leftOutNames.join(", ")}</span>
                </label>
                <div className="fold"><div><div className="cn-stack cn-gap-12">
                  {invalidResults.map((result, index) => (
                    <p className="cn-copy cn-m-0" key={`${result.competitorId}-${result.workload}-${result.sample}-${index}`}>
                      <b className="cn-text-text">{racerName(result.competitorId)}, {result.workload === "prose" ? "attention paper" : "nanoGPT code"}, sample {result.sample}.</b>{" "}
                      {result.validationMessage ?? "The output was not valid for ranking."}
                    </p>
                  ))}
                </div></div></div>
              </div>
            )}
          </div>
        </section>
      )}
    </section>
  );
}
