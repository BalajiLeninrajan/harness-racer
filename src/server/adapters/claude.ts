import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";

import type { ModelOption } from "../../shared/types.js";
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
    return { models: [], message: `Could not stat ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (discoveryCache?.key === key) return discoveryCache.discovery;
  let discovery: ModelDiscovery;
  try {
    const models = scanExecutableForModels(file, size);
    discovery = models.length ? { models } : { models, message: `No Claude model ids found in ${file}.` };
  } catch (error) {
    discovery = { models: [], message: `Could not read models from ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
  discoveryCache = { key, discovery };
  return discovery;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function abortError(): Error {
  const error = new Error("Benchmark cancelled");
  error.name = "AbortError";
  return error;
}

function runCommand(args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { env: process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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

async function runClaude(input: AdapterRunInput): Promise<AdapterRunOutput> {
  if (input.signal.aborted) throw abortError();
  let runtime: Query | undefined;
  let ready = false;
  const signalReady = () => {
    if (!ready) {
      ready = true;
      input.onReady();
    }
  };

  try {
    signalReady();
    await input.waitForStart();
    if (input.signal.aborted) throw abortError();

    runtime = query({
      prompt: input.prompt,
      options: {
        cwd: input.cwd,
        model: input.model,
        pathToClaudeCodeExecutable: "claude",
        includePartialMessages: true,
        maxTurns: 1,
        allowedTools: [],
        permissionMode: "plan",
        settingSources: ["user", "project", "local"],
      },
    });
    const onAbort = () => runtime?.close();
    input.signal.addEventListener("abort", onAbort, { once: true });
    let streamed = "";
    let finalAssistant = "";
    let nativeOutputTokens: number | undefined;
    try {
      for await (const message of runtime) {
        if (input.signal.aborted) throw abortError();
        const delta = claudeDelta(message);
        if (delta) {
          streamed += delta;
          input.onDelta(delta);
        }
        if (recordFrom(message)?.type === "assistant") finalAssistant = assistantText(message);
        if (recordFrom(message)?.type === "result") nativeOutputTokens = outputTokensFrom(message);
      }
      if (!streamed && finalAssistant) input.onDelta(finalAssistant);
      return nativeOutputTokens === undefined ? {} : { nativeOutputTokens };
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
  } catch (error) {
    signalReady();
    if (input.signal.aborted) throw abortError();
    throw error;
  } finally {
    runtime?.close();
  }
}

export const claudeAdapter = defineAdapter({
  id: "claudeAgent",
  name: "Claude",
  command: "claude",
}, {
  async probe(): Promise<AdapterProbeResult> {
    let version: CommandResult;
    try {
      version = await runCommand(["--version"]);
    } catch (error) {
      return {
        installed: false,
        authenticated: null,
        models: [],
        message: error instanceof Error ? error.message : String(error),
      };
    }
    let authenticated: boolean | null = null;
    try {
      const auth = await runCommand(["auth", "status", "--json"]);
      const status = JSON.parse(auth.stdout) as Record<string, unknown>;
      const explicit = status.loggedIn ?? status.authenticated;
      authenticated = typeof explicit === "boolean" ? explicit : auth.code === 0;
    } catch {
      authenticated = null;
    }
    const discovery = discoverClaudeModels();
    return {
      installed: version.code === 0,
      authenticated,
      version: (version.stdout || version.stderr).trim().split(/\r?\n/)[0],
      models: discovery.models.map((model) => ({ ...model })),
      ...(discovery.models[0] ? { defaultModel: discovery.models[0].id } : {}),
      ...(discovery.message ? { message: discovery.message } : {}),
    };
  },

  run: runClaude,
});
