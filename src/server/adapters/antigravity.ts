import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { ModelOption } from "../../shared/types.js";
import { recordFrom, stringFrom, stripAnsi, type JsonRecord } from "./lib/json.js";
import { normalizeModels, probeFailure } from "./lib/probe.js";
import { runCommand, type CommandResult } from "./lib/process.js";
import { runSession, type SessionPlan } from "./lib/run.js";
import { defineAdapter, type AdapterProbeResult, type AdapterRunInput, type AdapterRunOutput } from "./types.js";

// Drives the Antigravity CLI (`agy`) in headless print mode with NDJSON on both ends:
//   agy --input-format stream-json --output-format stream-json --model <id> --print=
// The CLI reads one message per stdin line and runs a turn for each, so a single
// process can be started ahead of the race and prompted at the shared start signal.
// T3 Code drives Antigravity through Google's separate ACP agent binary instead; that
// binary is a multi-gigabyte download with its own sign-in, while the CLI is what a
// developer actually installs and logs into, which is what Harness Racer measures.
const COMMAND = "agy";
const READY_EVENT = { event: "harness-racer/ready" };
const VERSION_TIMEOUT_MS = 15_000;
// `agy models` fetches the list from Google's backend and is slow to answer.
const MODELS_TIMEOUT_MS = 60_000;

/** `agy models` prints one `<id>\t<label>` line per model on stdout. */
export function parseModelList(stdout: string): ModelOption[] {
  const seen = new Set<string>();
  return stripAnsi(stdout).split(/\r?\n/).flatMap((line): ModelOption[] => {
    const match = /^(\S+)\t+(.+?)\s*$/.exec(line);
    if (!match || seen.has(match[1]!)) return [];
    seen.add(match[1]!);
    return [{ id: match[1]!, label: match[2]! }];
  });
}

/** The CLI stores its selected model by label in its settings file. */
function preferredModelLabel(): string | undefined {
  try {
    const settings = recordFrom(JSON.parse(readFileSync(path.join(homedir(), ".gemini", "antigravity-cli", "settings.json"), "utf8")));
    return stringFrom(settings?.model);
  } catch {
    return undefined;
  }
}

function isSignInMessage(text: string): boolean {
  return /sign in|not logged in|log in|login/i.test(text);
}

function outputTokensFrom(value: unknown): number | undefined {
  const usage = recordFrom(recordFrom(value)?.usage);
  const tokens = usage?.output_tokens;
  return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : undefined;
}

class AntigravityCliSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private stderr = "";
  private closed = false;
  private readonly ready: Promise<void>;
  private readonly finished: Promise<unknown>;
  private resolveReady!: () => void;
  private resolveFinished!: (result: unknown) => void;
  private rejectAll!: (error: Error) => void;

  constructor(model: string, cwd: string, private readonly onDelta: (text: string) => void) {
    let rejectReady: (error: Error) => void;
    let rejectFinished: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; rejectReady = reject; });
    this.finished = new Promise((resolve, reject) => { this.resolveFinished = resolve; rejectFinished = reject; });
    this.rejectAll = (error) => { rejectReady(error); rejectFinished(error); };
    // Unhandled rejections must not surface when a caller stops waiting early.
    this.ready.catch(() => {});
    this.finished.catch(() => {});

    this.child = spawn(COMMAND, ["--input-format", "stream-json", "--output-format", "stream-json", "--model", model, "--print="], {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.acceptChunk(chunk));
    this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-16_384); });
    this.child.once("error", (error) => this.rejectAll(error));
    // A write that lands after the CLI closed its read end raises EPIPE on
    // stdin; without a listener that is an uncaught exception.
    this.child.stdin.on("error", (error) => this.rejectAll(error));
    this.child.once("close", (code, signal) => {
      this.closed = true;
      const detail = stripAnsi(this.stderr).trim();
      this.rejectAll(new Error(`Antigravity CLI exited with ${signal ? `signal ${signal}` : `code ${code}`}${detail ? `: ${detail}` : ""}`));
    });
    // The CLI only consumes stdin once its own startup is done, and it creates the
    // conversation on the first message. An event it does not know is ignored with a
    // warning, so this ping costs nothing and its `init` reply marks the lane ready.
    this.write(READY_EVENT);
  }

  waitUntilReady(): Promise<void> {
    return this.ready;
  }

  /** Resolves with the turn's `result` payload once the CLI reports it. */
  prompt(text: string): Promise<unknown> {
    this.write({ event: "user", message: { role: "user", content: text } });
    return this.finished;
  }

  terminate(): void {
    if (this.closed || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    }, 1_500);
    timer.unref();
  }

  private write(message: JsonRecord): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private acceptChunk(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.acceptLine(line);
  }

  private acceptLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRecord | undefined;
    try {
      message = recordFrom(JSON.parse(line));
    } catch {
      return;
    }
    if (!message) return;
    switch (message.event) {
      case "init":
        this.resolveReady();
        return;
      case "step_update": {
        const update = recordFrom(message.step_update);
        if (update?.step_type === "agent_response" && typeof update.text_delta === "string" && update.text_delta) this.onDelta(update.text_delta);
        return;
      }
      case "result": {
        const result = recordFrom(message.result);
        if (result?.status !== undefined && result.status !== "SUCCESS") {
          const detail = typeof result.error === "string" && result.error.trim() ? result.error.trim() : String(result.status);
          this.rejectAll(new Error(`Antigravity CLI turn failed: ${detail}`));
          return;
        }
        this.resolveFinished(result);
        return;
      }
      default:
        return;
    }
  }
}

const antigravityPlan: SessionPlan<AntigravityCliSession> = {
  async open(ctx) {
    const session = new AntigravityCliSession(ctx.model, ctx.cwd, ctx.onDelta);
    ctx.onCleanup(() => session.terminate());
    await session.waitUntilReady();
    return session;
  },
  prompt: (session, text) => session.prompt(text),
  tokens: outputTokensFrom,
};

function runAntigravity(input: AdapterRunInput): Promise<AdapterRunOutput> {
  return runSession(input, antigravityPlan);
}

export const antigravityAdapter = defineAdapter({
  id: "antigravity",
  name: "Antigravity",
  command: COMMAND,
}, {
  async probe(): Promise<AdapterProbeResult> {
    let version: string;
    try {
      const result = await runCommand(COMMAND, ["--version"], { timeoutMs: VERSION_TIMEOUT_MS });
      if (result.code !== 0) throw new Error(stripAnsi(result.stderr || result.stdout).trim() || `${COMMAND} exited with code ${result.code}`);
      version = result.firstLine;
    } catch (error) {
      return probeFailure(error);
    }

    let listing: CommandResult;
    try {
      listing = await runCommand(COMMAND, ["models"], { timeoutMs: MODELS_TIMEOUT_MS });
    } catch (error) {
      return probeFailure(error, version);
    }
    const models = listing.code === 0 ? parseModelList(listing.stdout) : [];
    const noise = stripAnsi(`${listing.stderr}\n${listing.stdout}`).split(/\r?\n/).filter((line) => line.trim() && !/^Fetching available models/i.test(line) && !/^\S+\t/.test(line)).join(" ").trim();
    if (models.length === 0) {
      return {
        installed: true,
        authenticated: isSignInMessage(noise) ? false : null,
        version,
        models: [],
        message: noise || `${COMMAND} models returned no models`,
      };
    }
    const preferred = preferredModelLabel();
    const preferredId = models.find((model) => model.label === preferred || model.id === preferred)?.id;
    return {
      installed: true,
      authenticated: true,
      version,
      ...normalizeModels(models, preferredId),
    };
  },

  run: runAntigravity,
});
