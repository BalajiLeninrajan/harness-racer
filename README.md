# Harness Racer

[![CI](https://github.com/BalajiLeninrajan/harness-racer/actions/workflows/ci.yml/badge.svg)](https://github.com/BalajiLeninrajan/harness-racer/actions/workflows/ci.yml)
[![harness-racer on npm](https://img.shields.io/npm/v/harness-racer.svg?label=harness-racer)](https://www.npmjs.com/package/harness-racer)
[![Node.js](https://img.shields.io/node/v/harness-racer.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/BalajiLeninrajan/harness-racer/blob/main/LICENSE)

Race the coding-agent stacks already installed and authenticated on your machine. Harness Racer streams every response live and compares cold-start responsiveness, time to first output, visible tokens per second, and time to finish — in a browser dashboard or entirely in your terminal.

It measures the experience a harness actually gives you locally. It is not a raw model API benchmark and not a model-quality evaluation. It never asks for API keys.

## Install

Needs Node.js 22.13.0 or newer.

```console
npx harness-racer              # browser dashboard
npx harness-racer --cli        # terminal UI
```

```console
npm install -g harness-racer
```

## Usage

| Option | Effect |
| --- | --- |
| `--cli`, `--tui` | Use terminal mode |
| `--web` | Use the browser dashboard (default) |
| `--port <number>` | Browser server port (default: `4317`) |
| `--no-open` | Do not open the browser automatically |
| `--dev` | Use Vite middleware for browser development |
| `-h`, `--help` | Show help |

Pick 2–6 harness/model pairs, choose parallel or sequential sampling, and watch the lanes race. The server binds to `127.0.0.1` only, falling back to another local port if the requested one is busy.

## Supported harnesses

- Codex CLI via `codex app-server`
- Claude Code via the public Claude Agent SDK
- Cursor Agent via its persistent ACP session
- Grok CLI via ACP (`grok agent stdio`)
- OpenCode via its local server and SDK

## What it measures

| Metric | Definition |
| --- | --- |
| Harness prep | Launching and preparing the harness, until the lane is ready |
| Prompt → first output | Common start signal until the first visible streamed text |
| Cold start → first output | Harness prep plus prompt-to-first-output, excluding the parallel start barrier |
| Visible tokens / sec | Shared tokenizer over the first-to-last visible stream window |
| Prompt → finish | Common start signal to the final visible chunk; sets finishing order |

Each run uses an empty temporary directory and asks the agent to reproduce fixed prose and Python payloads without tools. A shared `o200k_base` tokenizer makes visible output speed comparable across providers.

## Methodology

Only exact, visibly streamed reproductions count. Warmups and invalid runs are excluded, and reported values are medians across both workloads. Quick measures one run per workload, Standard adds a warmup and three runs, Thorough a warmup and five.

Responses arriving as a single chunk or a burst shorter than 50ms are marked anomalous, since streaming speed is not measurable; racers whose runs are all anomalous are disqualified from rankings but stay visible. The dashboard's Methodology page covers the boundaries and limitations in full.

The prose payload is the abstract of [“Attention Is All You Need”](https://arxiv.org/abs/1706.03762) by Vaswani et al. The code payload is the MIT-licensed [`CausalSelfAttention.forward`](https://github.com/karpathy/nanoGPT/blob/master/model.py) excerpt from nanoGPT, copyright Andrej Karpathy.

## Development

```console
pnpm install
pnpm run ci          # typecheck, test, build — the same gate CI enforces
pnpm cli             # terminal mode from source
pnpm dev             # dashboard with Vite middleware
```
