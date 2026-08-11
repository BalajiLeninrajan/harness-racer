/* Simulated Harness Racer heat. Nothing here talks to a real harness — the
   timings are plausible fixtures replayed on a clock so the page shows what
   `npx harness-racer` looks like while it runs. */

const ICONS = {
  anthropic: '<path d="M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z"/>',
  openai: '<path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/>',
  cursor: '<path d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z"/>',
  grok: '<path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"/>',
  opencode: '<path d="M16 6H8v12h8V6zm4 16H4V2h16v20z"/>',
};

const LUCIDE = {
  loader: '<circle cx="12" cy="12" r="10" stroke-dasharray="45 15"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  code: '<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
};

/* Abstract of “Attention Is All You Need” (Vaswani et al.) and nanoGPT's
   CausalSelfAttention.forward — the two payloads the real benchmark replays. */
const WORKLOADS = {
  prose: {
    file: "attention.txt",
    text: `The dominant sequence transduction models are based on complex recurrent or convolutional neural networks in an encoder-decoder configuration. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely.

Experiments on two machine translation tasks show these models to be superior in quality while being more parallelizable and requiring significantly less time to train. Our model achieves 28.4 BLEU on the WMT 2014 English-to-German translation task, improving over the existing best results, including ensembles by over 2 BLEU.`,
  },
  code: {
    file: "model.py",
    text: `def forward(self, x):
    B, T, C = x.size() # batch size, sequence length, embedding dimensionality (n_embd)

    # calculate query, key, values for all heads in batch
    q, k, v = self.c_attn(x).split(self.n_embd, dim=2)
    k = k.view(B, T, self.n_head, C // self.n_head).transpose(1, 2) # (B, nh, T, hs)
    q = q.view(B, T, self.n_head, C // self.n_head).transpose(1, 2) # (B, nh, T, hs)
    v = v.view(B, T, self.n_head, C // self.n_head).transpose(1, 2) # (B, nh, T, hs)

    if self.flash:
        y = torch.nn.functional.scaled_dot_product_attention(q, k, v, is_causal=True)
    else:
        att = (q @ k.transpose(-2, -1)) * (1.0 / math.sqrt(k.size(-1)))
        att = att.masked_fill(self.bias[:,:,:T,:T] == 0, float('-inf'))
        att = F.softmax(att, dim=-1)
        y = att @ v # (B, nh, T, T) x (B, nh, T, hs) -> (B, nh, T, hs)

    y = y.transpose(1, 2).contiguous().view(B, T, C)
    return self.resid_dropout(self.c_proj(y))`,
  },
};

const HEATS = ["prose", "code"];
const CHARS_PER_TOKEN = 3.9;

const RACERS = [
  { id: "codex", label: "Codex CLI", model: "gpt-5.1-codex", icon: "openai", color: "#94e2d5", prep: 690, ttfo: 820, tps: 121 },
  { id: "claude", label: "Claude Code", model: "claude-opus-5", icon: "anthropic", color: "#cba6f7", prep: 1030, ttfo: 1180, tps: 94 },
  { id: "cursor", label: "Cursor Agent", model: "composer-1", icon: "cursor", color: "#f9e2af", prep: 1290, ttfo: 610, tps: 148 },
  { id: "opencode", label: "OpenCode", model: "grok-code-fast-1", icon: "grok", color: "#89b4fa", prep: 840, ttfo: 1490, tps: 77 },
];

const HOLD_AFTER_HEAT = 1400;
const HOLD_AFTER_RACE = 3200;

const formatMs = (value) =>
  value === undefined ? "—" : value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)}s` : `${Math.round(value)}ms`;
const formatRate = (value) => (value === undefined ? "—" : value.toFixed(value >= 100 ? 0 : 1));

const icon = (paths, stroke) =>
  `<svg viewBox="0 0 24 24" ${stroke ? 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' : 'fill="currentColor"'} aria-hidden="true">${paths}</svg>`;

const jitter = (base, spread) => base * (1 + (Math.random() * 2 - 1) * spread);

/* ── DOM ──────────────────────────────────────────────────────────────────── */

const field = RACERS;
let laneEls = {};

const lanesRoot = document.querySelector("[data-lanes]");
const heatNodes = Object.fromEntries(
  [...document.querySelectorAll("[data-heats] [data-heat]")].map((node) => [node.dataset.heat, node]),
);
const progressLabel = document.querySelector("[data-progress-label]");
const progressPercent = document.querySelector("[data-progress-percent]");
const progressBar = document.querySelector("[data-progress-bar]");

function buildField() {
  lanesRoot.innerHTML = field
    .map(
      (racer, index) => `
    <article class="race-lane status-queued" data-lane="${racer.id}" style="--lane-color:${racer.color}">
      <div class="lane-stripe"></div>
      <div class="lane-head">
        <span class="lane-position">P${index + 1}</span>
        <span class="harness-mark">${icon(ICONS[racer.icon])}</span>
        <div class="lane-identity"><strong>${racer.label}</strong><span>${racer.model}</span></div>
        <div class="lane-status" data-status></div>
      </div>
      <div class="lane-metrics">
        <div class="metric"><span>HARNESS PREP</span><strong data-prep>—</strong></div>
        <div class="metric" data-ttfo-metric><span>FIRST OUTPUT</span><strong data-ttfo>—</strong></div>
        <div class="metric" data-rate-metric><span>VISIBLE TOK/S</span><strong data-rate>—</strong></div>
      </div>
      <div class="stream-window">
        <div class="stream-toolbar">
          <span>${icon(LUCIDE.code, true)} <b data-file>awaiting-stream</b></span>
          <span data-sample>QUEUED</span>
        </div>
        <pre class="idle" data-output>Waiting for the green light…<span class="cursor hidden"></span></pre>
      </div>
      <div class="lane-progress"><span data-lane-progress style="width:0%"></span></div>
    </article>`,
    )
    .join("");

  laneEls = Object.fromEntries(
    field.map((racer) => {
      const root = lanesRoot.querySelector(`[data-lane="${racer.id}"]`);
      return [
        racer.id,
        {
          root,
          status: root.querySelector("[data-status]"),
          prep: root.querySelector("[data-prep]"),
          ttfo: root.querySelector("[data-ttfo]"),
          ttfoMetric: root.querySelector("[data-ttfo-metric]"),
          rate: root.querySelector("[data-rate]"),
          rateMetric: root.querySelector("[data-rate-metric]"),
          file: root.querySelector("[data-file]"),
          sample: root.querySelector("[data-sample]"),
          output: root.querySelector("[data-output]"),
          progress: root.querySelector("[data-lane-progress]"),
        },
      ];
    }),
  );
}

const totalRuns = () => field.length * HEATS.length;

/* ── Simulation state ─────────────────────────────────────────────────────── */

let lanes = {};
let heatIndex = 0;
let completedRuns = 0;
let clock = 0;
let phase = "racing";
let holdUntil = 0;

function resetRace() {
  heatIndex = 0;
  completedRuns = 0;
  startHeat();
}

function startHeat() {
  clock = 0;
  phase = "racing";
  lanes = Object.fromEntries(
    field.map((racer) => [
      racer.id,
      {
        status: "starting",
        prep: jitter(racer.prep, 0.18),
        ttfo: jitter(racer.ttfo, 0.22),
        charsPerMs: (jitter(racer.tps, 0.12) * CHARS_PER_TOKEN) / 1000,
        chars: 0,
        prepMs: undefined,
        ttfoMs: undefined,
        rate: undefined,
      },
    ]),
  );
  render();
}

function tick(deltaMs) {
  if (phase === "hold") {
    holdUntil -= deltaMs;
    if (holdUntil > 0) return;
    if (heatIndex < HEATS.length - 1) {
      heatIndex += 1;
      startHeat();
    } else {
      resetRace();
    }
    return;
  }

  clock += deltaMs;
  const corpus = WORKLOADS[HEATS[heatIndex]].text;

  for (const racer of field) {
    const lane = lanes[racer.id];
    if (lane.status === "complete") continue;

    if (lane.status === "starting") {
      if (clock < lane.prep) continue;
      lane.status = "running";
      lane.prepMs = lane.prep;
    }

    const sinceStart = clock - lane.prep;
    if (sinceStart < lane.ttfo) continue;
    lane.ttfoMs = lane.ttfo;

    const streaming = sinceStart - lane.ttfo;
    lane.chars = Math.min(corpus.length, streaming * lane.charsPerMs);
    lane.rate = streaming > 120 ? lane.chars / CHARS_PER_TOKEN / (streaming / 1000) : undefined;

    if (lane.chars >= corpus.length) {
      lane.status = "complete";
      lane.rate = corpus.length / CHARS_PER_TOKEN / (streaming / 1000);
      completedRuns += 1;
    }
  }

  if (field.every((racer) => lanes[racer.id].status === "complete")) {
    phase = "hold";
    holdUntil = heatIndex < HEATS.length - 1 ? HOLD_AFTER_HEAT : HOLD_AFTER_RACE;
  }

  render();
}

/* ── Render ───────────────────────────────────────────────────────────────── */

function render() {
  const heat = HEATS[heatIndex];
  const workload = WORKLOADS[heat];

  for (const [id, node] of Object.entries(heatNodes)) {
    const index = HEATS.indexOf(id);
    node.className = index === heatIndex ? "active" : index < heatIndex ? "done" : "";
  }

  const percent = Math.round((completedRuns / totalRuns()) * 100);
  progressLabel.textContent = `${completedRuns} / ${totalRuns()} runs complete`;
  progressPercent.textContent = `${percent}%`;
  progressBar.style.width = `${Math.max(2, percent)}%`;

  for (const racer of field) {
    const lane = lanes[racer.id];
    const el = laneEls[racer.id];
    const elapsedPrep = lane.status === "starting" ? clock : lane.prepMs;
    const elapsedTtfo =
      lane.ttfoMs === undefined ? (lane.status === "running" ? clock - lane.prep : undefined) : lane.ttfoMs;

    el.root.className = `race-lane status-${lane.status}`;
    el.status.innerHTML =
      lane.status === "running"
        ? '<span class="live-dot"></span> STREAMING'
        : lane.status === "complete"
          ? `${icon(LUCIDE.check, true)} HEAT DONE`
          : `${icon(LUCIDE.loader, true).replace("<svg", '<svg class="spin"')} STARTING`;

    el.prep.textContent = formatMs(elapsedPrep);
    el.ttfo.textContent = formatMs(elapsedTtfo);
    el.ttfoMetric.className = `metric${lane.ttfoMs !== undefined ? " metric-accent" : ""}`;
    el.rate.textContent = formatRate(lane.rate);
    el.rateMetric.className = `metric${lane.rate !== undefined ? " metric-accent" : ""}`;

    const streaming = lane.status !== "starting";
    el.file.textContent = streaming ? workload.file : "awaiting-stream";
    el.sample.textContent = streaming ? "SAMPLE 1" : "QUEUED";

    const shown = workload.text.slice(0, Math.floor(lane.chars));
    el.output.className = shown ? "" : "idle";
    el.output.textContent = shown || "Waiting for the green light…";
    const caret = document.createElement("span");
    caret.className = lane.status === "running" ? "cursor" : "cursor hidden";
    el.output.append(caret);
    if (lane.status === "running") el.output.scrollTop = el.output.scrollHeight;

    const laneRuns = lane.status === "complete" ? heatIndex + 1 : heatIndex;
    el.progress.style.width = `${(laneRuns / HEATS.length) * 100}%`;
  }
}

/* ── Clock ────────────────────────────────────────────────────────────────── */

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let last = 0;
let frame = 0;
let visible = false;

function loop(now) {
  const delta = last ? Math.min(100, now - last) : 16;
  last = now;
  tick(delta);
  frame = requestAnimationFrame(loop);
}

function play() {
  if (frame) return;
  last = 0;
  frame = requestAnimationFrame(loop);
}

function pause() {
  cancelAnimationFrame(frame);
  frame = 0;
}

function settle() {
  /* Reduced motion: jump straight to a finished heat, no streaming. */
  startHeat();
  tick(60000);
  completedRuns = totalRuns();
  heatIndex = HEATS.length - 1;
  phase = "hold";
  render();
}

buildField();

if (reduceMotion.matches) {
  settle();
} else {
  startHeat();
  new IntersectionObserver(
    (entries) => {
      visible = entries[0].isIntersecting;
      if (visible && !document.hidden) play();
      else pause();
    },
    { threshold: 0.08 },
  ).observe(document.querySelector("#race"));
  document.addEventListener("visibilitychange", () => (document.hidden || !visible ? pause() : play()));
}

/* ── Copy the install command ─────────────────────────────────────────────── */

const copyButton = document.querySelector("[data-copy]");
const copyLabel = copyButton.querySelector("[data-copy-label]");
let copyTimer = 0;

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(copyButton.dataset.copy);
    copyButton.classList.add("copied");
    copyLabel.textContent = "COPIED";
  } catch {
    copyLabel.textContent = "⌘C";
  }
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copyButton.classList.remove("copied");
    copyLabel.textContent = "COPY";
  }, 1800);
});
