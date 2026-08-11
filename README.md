# Harness Racer

[![CI](https://github.com/BalajiLeninrajan/harness-racer/actions/workflows/ci.yml/badge.svg)](https://github.com/BalajiLeninrajan/harness-racer/actions/workflows/ci.yml)
[![harness-racer on npm](https://img.shields.io/npm/v/harness-racer.svg?label=harness-racer)](https://www.npmjs.com/package/harness-racer)
[![Node.js](https://img.shields.io/node/v/harness-racer.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/BalajiLeninrajan/harness-racer/blob/main/LICENSE)

> [!WARNING]
> Harness Racer is a very early work in progress. It is under active development, incomplete, and not yet ready for general use.

Race the coding-agent stacks already authenticated on your machine. Harness Racer opens a local browser dashboard, streams every response live, and compares harness preparation, prompt-to-first-output, cold-start responsiveness, visible tokens per second, and prompt-to-finish time.

It measures the experience you actually get from a harness on your machine. It is not a raw model API benchmark and not a model-quality evaluation.

```console
$ npx harness-racer
Harness Racer is ready: http://127.0.0.1:4317
```

## Install

Harness Racer needs Node.js 22.13.0 or newer. Run it without installing:

```console
npx harness-racer
```

```console
pnpm dlx harness-racer
```

Or install the `harness-racer` command globally:

```console
npm install -g harness-racer
```

Or build from a clone of the repository:

```console
git clone https://github.com/BalajiLeninrajan/harness-racer
cd harness-racer
pnpm install
pnpm build
```

Harness Racer drives the harnesses already installed and authenticated on your machine. It never asks for API keys, and it only benchmarks the stacks it can discover locally.

## Quick start

The browser dashboard is the default:

```console
harness-racer
harness-racer --port 8080
harness-racer --no-open
```

Run the same benchmark entirely in your terminal:

```console
harness-racer --cli
```

The interactive terminal UI discovers locally available harnesses, lets you select 2–6 harness/model pairs, configures parallel or sequential sampling, shows live lane timing and output, and presents the final ranking.

Terminal controls are shown at the bottom of each screen. The lineup is an editable list (`a` adds a racer); each entry opens a two-tier harness/model picker. Use `h`/`j`/`k`/`l` (or arrow keys) to navigate and `/` to search models. On the starting grid, Space applies the focused choice and Enter starts the race. Enter confirms a model or zooms a live pane, Escape goes back or cancels a running race, and Ctrl+C exits.

From a clone, replace `harness-racer` with `pnpm cli` for terminal mode or `pnpm dev` for the dashboard with Vite middleware.

## Options

| Option | Effect |
| --- | --- |
| `--cli`, `--tui` | Use terminal mode |
| `--web` | Use the browser dashboard (default) |
| `--port <number>` | Browser server port (default: `4317`) |
| `--no-open` | Do not open the browser automatically |
| `--dev` | Use Vite middleware for browser development |
| `-h`, `--help` | Show help |

The server binds to `127.0.0.1` only. If the requested port is busy, Harness Racer falls back to an available local port.

## Supported harnesses

- Codex CLI via `codex app-server`
- Claude Code via the public Claude Agent SDK
- Cursor Agent via its persistent ACP session
- Grok CLI via ACP (`grok agent stdio`)
- OpenCode via its local server and SDK

Each run uses an empty temporary directory and asks the agent to reproduce fixed research-paper prose and Python code payloads without tools. Results use a shared `o200k_base` tokenizer so visible output speed is comparable across providers; provider-native token usage is retained only as secondary diagnostics.

## What it measures

Harness Racer intentionally measures the complete local experience: harness, model, provider route, network conditions, account configuration, and the local machine.

| Metric | Definition |
| --- | --- |
| Harness prep | Time an adapter spends launching and preparing its harness before declaring the lane ready |
| Prompt → first output | Common start signal until the first visible streamed text arrives |
| Cold start → first output | Harness prep plus prompt-to-first-output, excluding time waiting at the parallel start barrier |
| Visible tokens / sec | Shared tokenizer over the first-to-last visible stream window |
| Prompt → finish | Common start signal to the final visible output chunk; determines finishing order |

## Methodology

Only exact, visibly streamed reproductions are valid. Warmups and invalid runs are excluded; reported values are medians across the two fixed workloads. Quick uses one measured run per workload, Standard uses one warmup and three measured runs, and Thorough uses one warmup and five measured runs.

The dashboard's Methodology page documents the measurement boundaries, controls, sampling, and limitations in more detail. Responses delivered as one chunk or as a callback burst shorter than 50ms are marked anomalous because visible streaming speed is not measurable. Racers with any anomalous runs are flagged, and racers whose measured runs are all anomalous are disqualified from rankings while their recorded results remain visible.

The prose payload is the abstract of [“Attention Is All You Need”](https://arxiv.org/abs/1706.03762) by Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones, Aidan N. Gomez, Łukasz Kaiser, and Illia Polosukhin. The code payload is the MIT-licensed [`CausalSelfAttention.forward`](https://github.com/karpathy/nanoGPT/blob/master/model.py) excerpt from nanoGPT, copyright Andrej Karpathy.

## Development

```console
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm start -- --no-open
```

`pnpm run ci` runs the typecheck, test, and build gates together; it is the same gate CI enforces on every push and pull request. The built `dist/` directory contains the publishable CLI and browser assets.

## Releasing

Releases are cut from tags. Pushing a `v*` tag runs
[`.github/workflows/release.yml`](https://github.com/BalajiLeninrajan/harness-racer/blob/main/.github/workflows/release.yml),
which verifies the tag matches `package.json`, runs the full `ci` gate through `prepublishOnly`,
and publishes to npm with provenance.

```console
npm version patch
git push --follow-tags
```

`npm version` writes the bump, commits it, and creates the matching `v*` tag; the release workflow refuses to publish if the two ever disagree.

## License

MIT — see [LICENSE](https://github.com/BalajiLeninrajan/harness-racer/blob/main/LICENSE).
