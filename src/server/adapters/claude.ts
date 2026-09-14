import { spawn, type ChildProcessByStdio } from "node:child_process";
import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { startup, type Query, type SpawnOptions, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";

import type { ModelOption } from "../../shared/types.js";
import { errorMessage, recordFrom } from "./lib/json.js";
import { normalizeModels, probeFailure } from "./lib/probe.js";
import { runCommand } from "./lib/process.js";
import { abortError, runSession, type SessionPlan } from "./lib/run.js";
import { defineAdapter, type AdapterProbeResult, type AdapterRunInput, type AdapterRunOutput } from "./types.js";

// Claude Code has no model-listing surface: `claude` exposes no models subcommand, and the SDK's
// supportedModels() returns the interactive picker, which is narrowed by account tier and the
// settings cascade and so omits ids the CLI will still run. The installed executable carries the
// full table of ids it recognizes, so the model list is read from there instead.
// Version segments are capped at two digits so date-stamped ids (claude-opus-4-20250514) are
// skipped rather than read as a minor version; they alias a canonical id that is listed anyway.
const MODEL_ID_PATTERN = /claude-(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?(-fast)?(?![0-9a-zA-Z-])/g;
const FAMILY_LABELS: Record<string, string> = { opus: "Opus", fable: "Fable", sonnet: "Sonnet", haiku: "Haiku" };
const FAMILY_ORDER: Record<string, number> = { opus: 0, fable: 1, sonnet: 2, haiku: 3 };
const UNRANKED_FAMILY = Object.keys(FAMILY_ORDER).length;
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
const SCAN_OVERLAP_BYTES = 64;
// How long the CLI gets to exit on SIGTERM before SIGKILL, the same as the
// ACP lanes.
const KILL_GRACE_MS = 1_500;
// How long each of the probe's one-shot commands (--version, auth status) gets.
const PROBE_TIMEOUT_MS = 15_000;

interface ParsedModel {
  id: string;
  family: string;
  major: number;
  minor?: number;
  fast: boolean;
}

interface ModelDiscovery {
  models: ModelOption[];
  message?: string;
}

let discoveryCache: { key: string; discovery: ModelDiscovery } | undefined;

function resolveClaudeExecutable(): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "claude");
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}

function parsedModelFrom(match: RegExpMatchArray): ParsedModel {
  return {
    id: match[0],
    family: match[1],
    major: Number(match[2]),
    ...(match[3] === undefined ? {} : { minor: Number(match[3]) }),
    fast: Boolean(match[4]),
  };
}

// An omitted minor version means the same model as an explicit zero, so both spellings collapse
// onto one entry and the shorter id wins (claude-opus-4 over claude-opus-4-0).
function versionKey(model: ParsedModel): string {
  return `${model.family}-${model.major}-${model.minor ?? 0}${model.fast ? "-fast" : ""}`;
}

function compareModels(a: ParsedModel, b: ParsedModel): number {
  return b.major - a.major
    || (b.minor ?? -1) - (a.minor ?? -1)
    || (FAMILY_ORDER[a.family] ?? UNRANKED_FAMILY) - (FAMILY_ORDER[b.family] ?? UNRANKED_FAMILY)
    || Number(a.fast) - Number(b.fast);
}

function labelFor(model: ParsedModel): string {
  const family = FAMILY_LABELS[model.family] ?? model.family;
  const version = model.minor === undefined ? `${model.major}` : `${model.major}.${model.minor}`;
  return `Claude ${family} ${version}${model.fast ? " Fast" : ""}`;
}

function scanExecutableForModels(file: string, size: number): ModelOption[] {
  const found = new Map<string, ParsedModel>();
  const handle = openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
    let position = 0;
    let carry = "";
    while (position < size) {
      const bytes = readSync(handle, buffer, 0, SCAN_CHUNK_BYTES, position);
      if (bytes <= 0) break;
      position += bytes;
      const text = carry + buffer.toString("latin1", 0, bytes);
      // Ids straddling a chunk edge are rescanned with the next chunk's context, so the trailing
      // window is skipped here to keep the pattern's end-of-id lookahead honest.
      const limit = position >= size ? text.length : text.length - SCAN_OVERLAP_BYTES;
      for (const match of text.matchAll(MODEL_ID_PATTERN)) {
        if ((match.index ?? 0) + match[0].length > limit) continue;
        const parsed = parsedModelFrom(match);
        const key = versionKey(parsed);
        const existing = found.get(key);
        if (!existing || parsed.id.length < existing.id.length) found.set(key, parsed);
      }
      carry = text.slice(-SCAN_OVERLAP_BYTES);
    }
  } finally {
    closeSync(handle);
  }
  return [...found.values()].sort(compareModels).map((model, index) => ({
    id: model.id,
    label: labelFor(model),
    ...(index === 0 ? { isDefault: true } : {}),
  }));
}

function discoverClaudeModels(): ModelDiscovery {
  const file = resolveClaudeExecutable();
  if (!file) return { models: [], message: "Could not resolve the claude executable on PATH." };
  let key: string;
  let size: number;
  try {
    const stats = statSync(file);
    size = stats.size;
    key = `${file}:${stats.size}:${stats.mtimeMs}`;
  } catch (error) {
    return { models: [], message: `Could not stat ${file}: ${errorMessage(error)}` };
  }
  if (discoveryCache?.key === key) return discoveryCache.discovery;
  let discovery: ModelDiscovery;
  try {
    const models = scanExecutableForModels(file, size);
    discovery = models.length ? { models } : { models, message: `No Claude model ids found in ${file}.` };
  } catch (error) {
    discovery = { models: [], message: `Could not read models from ${file}: ${errorMessage(error)}` };
  }
  discoveryCache = { key, discovery };
  return discovery;
}

function claudeDelta(value: unknown): string | undefined {
  const message = recordFrom(value);
  if (message?.type !== "stream_event") return undefined;
  const event = recordFrom(message.event);
  const delta = recordFrom(event?.delta);
  return event?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string"
    ? delta.text
    : undefined;
}

function assistantText(value: unknown): string {
  const message = recordFrom(recordFrom(value)?.message);
  if (!Array.isArray(message?.content)) return "";
  return message.content.flatMap((block) => {
    const record = recordFrom(block);
    return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
  }).join("");
}

function outputTokensFrom(value: unknown): number | undefined {
  const record = recordFrom(value);
  if (!record) return undefined;
  const usage = recordFrom(record.usage);
  const candidate = usage?.output_tokens ?? usage?.outputTokens;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

type ClaudeProcess = ChildProcessByStdio<Writable, Readable, null>;

interface ClaudeSession {
  warm: WarmQuery;
  onDelta: (text: string) => void;
  // Set once the prompt is sent; the handle to close from then on, because
  // WarmQuery.close() is a no-op after query().
  runtime?: Query;
}

// Spawns the CLI on the SDK's behalf so the adapter keeps the child handle.
// The SDK's own close() only ends stdin, waits 2 s before SIGTERM and another
// 5 s before SIGKILL, and aborting its controller after close() is deferred
// behind the same 2 s timer. All of that is past the engine's teardown grace,
// so a cancelled or timed-out lane would leave a claude process streaming
// from the API under the next lane, and under the workspace's deletion.
function spawnClaude(options: SpawnOptions): ClaudeProcess {
  return spawn(options.command, options.args, {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: options.env,
    shell: false,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
}

function terminate(child: ClaudeProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, KILL_GRACE_MS);
  timer.unref();
}

// The SDK's startup() spawns the CLI and completes its initialize handshake
// before resolving, so the lane is ready at the same point as the ACP lanes:
// process up, signed in, model chosen. query() then writes the prompt straight
// to that process, and the CLI's boot no longer counts against the prompt.
const claudePlan: SessionPlan<ClaudeSession> = {
  async open(ctx) {
    // Reaches the CLI while its handshake is still running, when there is no
    // query handle to close yet.
    const abortController = new AbortController();
    let child: ClaudeProcess | undefined;
    const session: Partial<ClaudeSession> & Pick<ClaudeSession, "onDelta"> = { onDelta: ctx.onDelta };
    ctx.onCleanup(() => {
      // close() first so the SDK stops reading and ends stdin; the kill then
      // lands on a process the SDK already treats as aborted.
      if (session.runtime) session.runtime.close();
      else session.warm?.close();
      abortController.abort();
      if (child) terminate(child);
    });
    session.warm = await startup({
      options: {
        cwd: ctx.cwd,
        model: ctx.model,
        pathToClaudeCodeExecutable: "claude",
        includePartialMessages: true,
        maxTurns: 1,
        allowedTools: [],
        permissionMode: "plan",
        settingSources: ["user", "project", "local"],
        abortController,
        spawnClaudeCodeProcess: (options) => {
          child = spawnClaude(options);
          // Teardown can have run before the SDK got as far as spawning.
          if (abortController.signal.aborted) terminate(child);
          return child;
        },
      },
    });
    return session as ClaudeSession;
  },

  async prompt(session, text, signal) {
    const runtime = session.warm.query(text);
    session.runtime = runtime;
    let streamed = "";
    let finalAssistant = "";
    let result: unknown;
    for await (const message of runtime) {
      if (signal.aborted) throw abortError();
      const delta = claudeDelta(message);
      if (delta) {
        streamed += delta;
        session.onDelta(delta);
      }
      if (recordFrom(message)?.type === "assistant") finalAssistant = assistantText(message);
      if (recordFrom(message)?.type === "result") result = message;
    }
    if (!streamed && finalAssistant) session.onDelta(finalAssistant);
    return result;
  },

  tokens: outputTokensFrom,
};

function runClaude(input: AdapterRunInput): Promise<AdapterRunOutput> {
  return runSession(input, claudePlan);
}

export const claudeAdapter = defineAdapter({
  id: "claudeAgent",
  name: "Claude",
  command: "claude",
}, {
  async probe(): Promise<AdapterProbeResult> {
    let version: string;
    try {
      const result = await runCommand("claude", ["--version"], { timeoutMs: PROBE_TIMEOUT_MS });
      if (result.code !== 0) throw new Error(result.output || `claude --version exited with code ${result.code}`);
      version = result.firstLine;
    } catch (error) {
      return probeFailure(error);
    }
    let authenticated: boolean | null = null;
    try {
      const auth = await runCommand("claude", ["auth", "status", "--json"], { timeoutMs: PROBE_TIMEOUT_MS });
      const status = recordFrom(JSON.parse(auth.stdout)) ?? {};
      const explicit = status.loggedIn ?? status.authenticated;
      authenticated = typeof explicit === "boolean" ? explicit : auth.code === 0;
    } catch {
      authenticated = null;
    }
    const discovery = discoverClaudeModels();
    return {
      installed: true,
      authenticated,
      version,
      ...normalizeModels(discovery.models),
      ...(discovery.message ? { message: discovery.message } : {}),
    };
  },

  run: runClaude,
});
