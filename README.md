# TPS Racer

Race models through the coding-agent subscriptions already authenticated on your machine. TPS Racer opens a local browser dashboard, streams every response live, and compares time to first token (TTFT), cold-start latency, normalized visible tokens per second (TPS), and total response time.

## Run locally

```bash
pnpm install
pnpm benchmark
```

The dashboard opens at `http://127.0.0.1:4317`. It shows only harnesses detected on the machine, then lets you pick models and start the race.

## Distribution

The package is designed for zero-install use after publication:

```bash
npx tps-racer@latest
```

A normal hosted website cannot directly start local coding-agent CLIs or reuse their local subscription credentials. The `npx` package is the local companion: it binds only to loopback, launches the agents on the same machine, and serves the browser UI. A hosted landing page can document the tool, but the benchmark itself must run locally unless users install a separate daemon.

## Supported harnesses

- Codex CLI via `codex app-server`
- Claude Code via the public Claude Agent SDK
- Cursor Agent via its persistent ACP session
- Grok CLI via ACP (`grok agent stdio`)
- OpenCode via its local server and SDK

Each run uses an empty temporary directory and asks the agent to reproduce fixed prose and code payloads without tools. Results use a shared `o200k_base` tokenizer so visible TPS is comparable across providers; provider-native token usage is retained only as secondary diagnostics.

## Build and test

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm start -- --no-open
```

The built `dist/` directory contains the publishable CLI and browser assets.
