import { ArrowLeft, Clock3 } from "lucide-react";
import type { CSSProperties } from "react";

interface AboutProps {
  onBack: () => void;
}

const metrics = [
  ["Harness prep", "Time spent launching and preparing the harness before the lane is ready."],
  ["Prompt → first output", "Time from the start signal until the first visible text reaches Harness Racer."],
  ["Cold start → first output", "Harness prep plus prompt-to-first-output, excluding any wait at the parallel start barrier."],
  ["Visible tokens / sec", "Visible output counted with the same tokenizer for every racer, divided by the visible streaming window."],
  ["Prompt → finish", "Time from the start signal to the final visible chunk. This determines finishing order."],
] as const;

export function About({ onBack }: AboutProps) {
  return (
    <section className="page-main page-enter" style={{ "--page-width": "1120px" } as CSSProperties}>
      <button className="btn btn-ghost is-sm" onClick={onBack}><ArrowLeft /> Back to the starting grid</button>

      <header className="cn-mt-28 cn-mb-8">
        <h1 className="cn-display cn-m-0">Methodology</h1>
        <p className="cn-lede cn-mt-12 cn-mb-0">
          Harness Racer measures the speed of the local harness and model combination you run. Results can also
          reflect provider routing, network conditions, account configuration, and your machine. This is not
          a model-quality test or a raw model API benchmark.
        </p>
      </header>

      <section className="method-section">
        <div className="cn-row cn-top cn-gap-12 cn-mb-16">
          <span className="mark-solid">01</span>
          <h2 className="cn-title cn-m-0">Test text</h2>
        </div>
        <div className="limits-card well cn-p-16 source-copy">
          <p>Each racer is asked to reproduce the same two fixed texts exactly:</p>
          <ul>
            <li>
              Prose: the abstract of <a href="https://arxiv.org/abs/1706.03762" target="_blank" rel="noreferrer">“Attention Is All You Need”</a> by
              Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan N. Gomez, Łukasz Kaiser, and Illia Polosukhin.
            </li>
            <li>
              Code: <a href="https://github.com/karpathy/nanoGPT/blob/master/model.py" target="_blank" rel="noreferrer"><code className="cn-code">CausalSelfAttention.forward</code> from nanoGPT</a>,
              copyright Andrej Karpathy and used under the MIT License.
            </li>
          </ul>
          <p>Runs use an empty temporary directory, tools are disabled or denied, and each run has a 120-second limit. Only exact reproductions count.</p>
        </div>
      </section>

      <section className="method-section cn-grid-2 cn-gap-28">
        <div>
          <div className="cn-row cn-top cn-gap-12 cn-mb-16">
            <span className="mark-solid">02</span>
            <h2 className="cn-title cn-m-0">Run order</h2>
          </div>
          <div className="sample-table well cn-divide">
            <div><span className="cn-microlabel cn-text-mauve">PARALLEL</span><strong>All racers prepare, then start together. This is faster, but they share local resources and network capacity.</strong></div>
            <div><span className="cn-microlabel cn-text-mauve">SEQUENTIAL</span><strong>Racers run one at a time. This takes longer but reduces contention between racers.</strong></div>
          </div>
        </div>
        <div>
          <div className="cn-row cn-top cn-gap-12 cn-mb-16">
            <span className="mark-solid">03</span>
            <h2 className="cn-title cn-m-0">Samples</h2>
          </div>
          <div className="sample-table well cn-divide">
            <div><span className="cn-microlabel cn-text-mauve">QUICK</span><strong>No warmup, then 1 measured run for each text (2 measured runs total per racer).</strong></div>
            <div><span className="cn-microlabel cn-text-mauve">STANDARD</span><strong>1 warmup and 3 measured runs for each text (2 warmups and 6 measured runs total).</strong></div>
            <div><span className="cn-microlabel cn-text-mauve">THOROUGH</span><strong>1 warmup and 5 measured runs for each text (2 warmups and 10 measured runs total).</strong></div>
          </div>
        </div>
      </section>

      <section className="method-section">
        <div className="cn-row cn-top cn-gap-12 cn-mb-16">
          <span className="mark-solid">04</span>
          <h2 className="cn-title cn-m-0">Measurements and ranking</h2>
        </div>
        <div className="metric-definitions well cn-divide">
          {metrics.map(([label, description]) => (
            <article key={label}>
              <div><h3>{label}</h3><p>{description}</p></div>
            </article>
          ))}
        </div>
        <p className="boundary-note">
          <Clock3 size={15} /> Results are medians of valid measured runs across both texts. Warmups and invalid outputs are excluded.
          Harnesses expose different readiness boundaries, so harness prep is based on when each adapter declares itself ready.
        </p>
      </section>

      <section className="method-section">
        <div className="cn-row cn-top cn-gap-12 cn-mb-16">
          <span className="mark-solid">05</span>
          <h2 className="cn-title cn-m-0">Limitations</h2>
        </div>
        <div className="limits-card well cn-p-16">
          <ul>
            <li>Hidden reasoning and provider-native token counts are not compared.</li>
            <li>Account tier, configuration, provider load, network conditions, and the local machine can affect results.</li>
            <li>Results are a point-in-time local measurement. Repeat important comparisons at different times.</li>
          </ul>
        </div>
      </section>
    </section>
  );
}
