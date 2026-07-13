# Harness Racer

Race the coding-agent stacks already authenticated on your machine. Harness Racer opens a local browser dashboard, streams every response live, and compares harness preparation, prompt-to-first-output, cold-start responsiveness, visible tokens per second, and prompt-to-finish time.

## Run locally

```bash
pnpm install
pnpm benchmark
```

The dashboard opens at `http://127.0.0.1:4317`. It shows only harnesses detected on the machine, then lets you pick models and start the race.

## Terminal mode

Run the same benchmark entirely in your terminal:

```bash
pnpm cli
```

After the package is published, use `harness-racer --cli` (or `--tui`). The interactive terminal UI discovers locally available harnesses, lets you select 2–6 harness/model pairs, configures parallel or sequential sampling, shows live lane timing and output, and presents the final ranking. The browser dashboard remains the default when no mode flag is given.

Terminal controls are shown at the bottom of each screen. The lineup is an editable list (`a` adds a racer); each entry opens a two-tier harness/model picker. Use `h`/`j`/`k`/`l` (or arrow keys) to navigate and `/` to search models. On the starting grid, Space applies the focused choice and Enter starts the race. Enter confirms a model or zooms a live pane, Escape goes back or cancels a running race, and Ctrl+C exits.

## Distribution

The package is designed for zero-install use after publication:

```bash
npx harness-racer@latest
```

A normal hosted website cannot directly start local coding-agent CLIs or reuse their local subscription credentials. The `npx` package is the local companion: it binds only to loopback, launches the agents on the same machine, and serves the browser UI. A hosted landing page can document the tool, but the benchmark itself must run locally unless users install a separate daemon.

## Supported harnesses

- Codex CLI via `codex app-server`
- Claude Code via the public Claude Agent SDK
- Cursor Agent via its persistent ACP session
- Grok CLI via ACP (`grok agent stdio`)
- OpenCode via its local server and SDK

Each run uses an empty temporary directory and asks the agent to reproduce fixed research-paper prose and Python code payloads without tools. Results use a shared `o200k_base` tokenizer so visible output speed is comparable across providers; provider-native token usage is retained only as secondary diagnostics.

## Methodology

Harness Racer intentionally measures the complete local experience: harness, model, provider route, network conditions, account configuration, and the local machine. It is not a raw model API benchmark or a model-quality evaluation.

- **Harness prep** is the time an adapter spends launching and preparing its harness before declaring the lane ready.
- **Prompt → first output** runs from the common start signal until the first visible streamed text reaches Harness Racer.
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
```

The built `dist/` directory contains the publishable CLI and browser assets.
