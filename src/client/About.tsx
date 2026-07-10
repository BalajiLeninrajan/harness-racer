import {
  ArrowLeft,
  Check,
  Clock3,
  Gauge,
  Layers3,
  ShieldCheck,
  Target,
  TimerReset,
  Zap,
} from "lucide-react";

interface AboutProps {
  onBack: () => void;
}

const stackParts = ["Harness", "Model", "Provider route", "Network", "Your machine"];

const metrics = [
  {
    label: "Harness prep",
    short: "PREP",
    description: "Time the adapter spends launching and preparing its harness before it declares the lane ready.",
  },
  {
    label: "Prompt → first output",
    short: "FIRST",
    description: "From the common start signal until the first visible streamed text reaches TPS Racer.",
  },
  {
    label: "Cold start → first output",
    short: "COLD",
    description: "Harness prep plus prompt-to-first-output. Time spent waiting at the parallel start barrier is excluded.",
  },
  {
    label: "Visible tokens / sec",
    short: "TOK/S",
    description: "Visible output counted with one shared tokenizer, divided by the first-to-last stream window.",
  },
  {
    label: "Prompt → finish",
    short: "FINISH",
    description: "From the common start signal until the final visible output chunk. This metric decides the finishing order.",
  },
];

export function About({ onBack }: AboutProps) {
  return (
    <section className="about-view page-enter">
      <button className="back-button" onClick={onBack}><ArrowLeft size={16} /> Back to the starting grid</button>

      <div className="about-hero">
        <div>
          <div className="eyebrow"><Layers3 size={14} /> WHAT THIS RACE MEASURES</div>
          <h1>The stack you use.<br /><em>Not a model in a vacuum.</em></h1>
          <p>
            TPS Racer measures the local coding-agent experience end to end. Harness startup,
            model behavior, provider routing, streaming protocol, network conditions, and your
            machine all shape the result—and that dependence is intentional.
          </p>
        </div>
        <div className="about-thesis panel">
          <Gauge size={26} />
          <strong>A practical speed test</strong>
          <p>“Which harness + model combination feels fastest for me, right now?”</p>
        </div>
      </div>

      <div className="stack-equation" aria-label="Components included in every benchmark result">
        {stackParts.map((part, index) => (
          <div key={part}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{part}</strong>
            {index < stackParts.length - 1 && <i aria-hidden="true">+</i>}
          </div>
        ))}
        <b aria-hidden="true">=</b>
        <div className="stack-result"><Zap size={18} /><strong>Measured experience</strong></div>
      </div>

      <section className="method-section">
        <div className="method-heading">
          <span>01</span>
          <div><h2>How every heat works</h2><p>Controls keep the race comparable without pretending the harnesses are identical.</p></div>
        </div>
        <div className="method-grid">
          <article className="panel">
            <Target size={20} />
            <h3>Same target</h3>
            <p>Every lane receives the same fixed research-paper prose and Python reproduction prompts. Output length and content are controlled.</p>
          </article>
          <article className="panel">
            <ShieldCheck size={20} />
            <h3>Isolated run</h3>
            <p>Each attempt gets an empty temporary directory. Tools are disabled or denied, and every run has a 120-second limit.</p>
          </article>
          <article className="panel">
            <TimerReset size={20} />
            <h3>Fair starting gun</h3>
            <p>Same-gun mode holds ready lanes behind a barrier. Time-trial mode runs each stack separately to avoid local contention.</p>
          </article>
          <article className="panel">
            <Check size={20} />
            <h3>Valid output only</h3>
            <p>The response must match the target and arrive as a visible stream. Invalid and warmup runs never enter the ranking.</p>
          </article>
        </div>
      </section>

      <section className="method-section">
        <div className="method-heading">
          <span>02</span>
          <div><h2>What the clocks mean</h2><p>The labels describe observable stack behavior, not private model-inference phases.</p></div>
        </div>
        <div className="metric-definitions panel">
          {metrics.map((metric) => (
            <article key={metric.short}>
              <span>{metric.short}</span>
              <div><h3>{metric.label}</h3><p>{metric.description}</p></div>
            </article>
          ))}
        </div>
        <p className="boundary-note">
          <Clock3 size={15} /> Harness APIs expose different lifecycle boundaries. “Harness prep” therefore means
          adapter-declared readiness; remaining handoff work naturally appears in prompt-to-first-output. That is part of the stack comparison.
        </p>
      </section>

      <section className="method-section method-split">
        <div>
          <div className="method-heading compact">
            <span>03</span>
            <div><h2>Sampling and ranking</h2></div>
          </div>
          <div className="sample-table panel">
            <div><span>QUICK</span><strong>0 warmups · 1 measured run per workload</strong></div>
            <div><span>STANDARD</span><strong>1 warmup · 3 measured runs per workload</strong></div>
            <div><span>THOROUGH</span><strong>1 warmup · 5 measured runs per workload</strong></div>
          </div>
          <p className="method-copy">Results are medians across valid, measured paper and Python runs. Prompt-to-finish sets the ranking; values within 1% share a best mark.</p>
        </div>
        <div>
          <div className="method-heading compact">
            <span>04</span>
            <div><h2>What it does not claim</h2></div>
          </div>
          <div className="limits-card panel">
            <p>This is not a model-quality evaluation, a raw API benchmark, or a laboratory measure of inference hardware.</p>
            <ul>
              <li>Hidden reasoning and provider-native tokens are not used for cross-stack speed.</li>
              <li>Account tier, user configuration, provider load, and network conditions can affect a run.</li>
              <li>Results are a local snapshot; repeat serious comparisons at different times.</li>
            </ul>
          </div>
        </div>
      </section>

      <div className="about-cta panel">
        <div><span>READY?</span><h2>Race the stacks you actually use.</h2></div>
        <button className="primary-button" onClick={onBack}>Build the starting grid <ArrowLeft className="arrow-forward" size={17} /></button>
      </div>
    </section>
  );
}
