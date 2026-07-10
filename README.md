# TPS Racer

Race the coding-agent stacks already authenticated on your machine. TPS Racer runs in a local browser dashboard by default or entirely in your terminal with `--cli`, streams every response live, and compares harness preparation, prompt-to-first-output, cold-start responsiveness, visible tokens per second, and prompt-to-finish time.

## Run locally

```bash
pnpm install
pnpm benchmark
```

The dashboard opens at `http://127.0.0.1:4317`. It shows only harnesses detected on the machine, then lets you pick models and start the race.

## Run in the terminal

Pass `--cli` to run the same benchmark without starting a local web server or opening a browser:

```bash
pnpm benchmark -- --cli
```

On an interactive terminal, this opens a full-screen keyboard-driven UI with an editable starting grid, searchable model picker, tmux-style live output panes for every racer, and a detailed final classification with winner gaps, per-workload timing, validity, and failure diagnostics. Use the arrow keys to move, `Space` to choose models, `A`/`D` to add or remove lanes, `M`/`P` to change race settings, and `Enter` to start.

Piped or non-interactive environments retain a plain-text fallback. Both interfaces use the same benchmark engine and report median prompt-to-first-output, cold-start-to-first-output, visible-token speed, and prompt-to-finish ranking just like the browser dashboard.

Once published, the equivalent zero-install command is:

```bash
pnpm dlx tps-racer@latest --cli
```

Press `Ctrl-C` during a race to cancel it and clean up the active runs.

## Distribution

The package is designed for zero-install use after publication:

```bash
npx tps-racer@latest
```

A normal hosted website cannot directly start local coding-agent CLIs or reuse their local subscription credentials. The package is the local companion: it launches the agents on the same machine and either serves the browser UI on loopback or runs the terminal flow directly. A hosted landing page can document the tool, but the benchmark itself must run locally unless users install a separate daemon.

## Supported harnesses

- Codex CLI via `codex app-server`
- Claude Code via the public Claude Agent SDK
- Cursor Agent via its persistent ACP session
- Grok CLI via ACP (`grok agent stdio`)
- OpenCode via its local server and SDK

Each run uses an empty temporary directory and asks the agent to reproduce fixed research-paper prose and Python code payloads without tools. Results use a shared `o200k_base` tokenizer so visible output speed is comparable across providers; provider-native token usage is retained only as secondary diagnostics.

## Methodology

TPS Racer intentionally measures the complete local experience: harness, model, provider route, network conditions, account configuration, and the local machine. It is not a raw model API benchmark or a model-quality evaluation.

- **Harness prep** is the time an adapter spends launching and preparing its harness before declaring the lane ready.
- **Prompt → first output** runs from the common start signal until the first visible streamed text reaches TPS Racer.
- **Cold start → first output** combines harness prep and prompt-to-first-output, excluding time spent waiting at the parallel start barrier.
- **Visible tokens / sec** uses the shared tokenizer over the first-to-last visible stream window.
- **Prompt → finish** runs from the common start signal to the final visible output chunk and determines finishing order.

Only exact, visibly streamed reproductions are valid. Warmups and invalid runs are excluded; reported values are medians across the two fixed workloads. Quick uses one measured run per workload, Standard uses one warmup and three measured runs, and Thorough uses one warmup and five measured runs.

The dashboard's Methodology page documents the measurement boundaries, controls, sampling, and limitations in more detail. Responses delivered as one chunk or as a callback burst shorter than 50ms are marked anomalous because visible streaming speed is not measurable. Racers with any anomalous runs are flagged, and racers whose measured runs are all anomalous are disqualified from rankings while their recorded results remain visible.

The prose payload is the abstract of [“Attention Is All You Need”](https://arxiv.org/abs/1706.03762) by Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan N. Gomez, Łukasz Kaiser, and Illia Polosukhin. The code payload is the MIT-licensed [`CausalSelfAttention.forward`](https://github.com/karpathy/nanoGPT/blob/master/model.py) excerpt from nanoGPT, copyright Andrej Karpathy.

## Build and test

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm start -- --no-open
pnpm start -- --cli
```

The built `dist/` directory contains the publishable CLI and browser assets.
