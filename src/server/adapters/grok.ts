import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { ModelOption } from "../../shared/types.js";
import { outputTokensFrom, recordFrom, stringFrom, type JsonRecord } from "./lib/json.js";
import { bounded, normalizeModels, probeFailure, type ModelList } from "./lib/probe.js";
import { runCommand } from "./lib/process.js";
import { abortError, runSession, type SessionPlan } from "./lib/run.js";
import { defineAdapter, type AdapterProbeResult, type AdapterRunInput, type AdapterRunOutput } from "./types.js";

// The --version spawn and the ACP handshake each get this long before the
// probe gives up on them.
const PROBE_TIMEOUT_MS = 20_000;

/** An error reply from the agent to one request, as opposed to the process failing. */
class GrokRpcError extends Error {
  constructor(readonly method: string, detail: unknown) {
    super(`Grok ACP ${method} failed${typeof detail === "string" ? `: ${detail}` : ""}`);
    this.name = "GrokRpcError";
  }
}

class GrokAcpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private closed = false;
  private readonly pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(cwd: string, private readonly onNotification: (method: string, params: unknown) => void) {
    this.child = spawn("grok", ["agent", "stdio"], {
      cwd,
      env: { ...process.env, GROK_OAUTH2_REFERRER: "t3code" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.acceptChunk(chunk));
    this.child.stderr.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-16_384); });
    this.child.once("error", (error) => this.failAll(error));
    // A write that lands after the child closed its read end raises EPIPE on
    // stdin; without a listener that is an uncaught exception.
    this.child.stdin.on("error", (error) => this.failAll(error));
    this.child.once("close", (code, signal) => {
      this.closed = true;
      this.failAll(new Error(`Grok ACP exited with ${signal ? `signal ${signal}` : `code ${code}`}${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`));
    });
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Grok ACP process is closed"));
    if (signal?.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const settle = <T>(fn: (value: T) => void) => (value: T) => {
        signal?.removeEventListener("abort", onAbort);
        fn(value);
      };
      this.pending.set(id, { method, resolve: settle(resolve), reject: settle(reject) });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) this.write({ jsonrpc: "2.0", method, params });
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
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private acceptChunk(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.acceptLine(line);
  }

  private acceptLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRecord;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!recordFrom(parsed)) return;
      message = parsed as JsonRecord;
    } catch {
      return;
    }
    if (typeof message.id === "number" && !message.method && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new GrokRpcError(pending.method, recordFrom(message.error)?.message));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") return;
    if (message.id !== undefined) {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        result: message.method === "session/request_permission"
          ? { outcome: { outcome: "cancelled" } }
          : undefined,
        ...(message.method === "session/request_permission" ? {} : { error: { code: -32601, message: `Unsupported client method: ${message.method}` } }),
      });
      return;
    }
    this.onNotification(message.method, message.params);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function modelsFromSession(session: unknown): ModelList {
  const modelState = recordFrom(recordFrom(session)?.models);
  const available = Array.isArray(modelState?.availableModels) ? modelState.availableModels : [];
  const current = stringFrom(modelState?.currentModelId);
  const models = available.flatMap((value): ModelOption[] => {
    const model = recordFrom(value);
    const id = stringFrom(model?.modelId);
    return id ? [{ id, label: stringFrom(model?.name) ?? id }] : [];
  });
  return normalizeModels(models, current);
}

async function openSession(connection: GrokAcpConnection, cwd: string, signal?: AbortSignal) {
  await connection.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "harness-racer", version: "0.1.0" },
  }, signal);
  await connection.request("authenticate", { methodId: process.env.XAI_API_KEY?.trim() ? "xai.api_key" : "cached_token" }, signal);
  const session = await connection.request("session/new", { cwd, mcpServers: [] }, signal);
  const sessionId = recordFrom(session)?.sessionId;
  if (typeof sessionId !== "string") throw new Error("Grok ACP session/new returned no sessionId");
  return { session, sessionId };
}

async function discoverGrokModels(): Promise<ModelList> {
  const connection = new GrokAcpConnection(process.cwd(), () => {});
  const deadline = new AbortController();
  try {
    const started = await bounded(
      openSession(connection, process.cwd(), deadline.signal),
      PROBE_TIMEOUT_MS,
      `Grok ACP handshake did not finish within ${Math.round(PROBE_TIMEOUT_MS / 1000)}s`,
      () => {
        deadline.abort();
        connection.terminate();
      },
    );
    return modelsFromSession(started.session);
  } finally {
    connection.terminate();
  }
}

interface GrokSession {
  connection: GrokAcpConnection;
  sessionId: string;
}

const grokPlan: SessionPlan<GrokSession> = {
  async open(ctx) {
    let sessionId: string | undefined;
    const connection = new GrokAcpConnection(ctx.cwd, (method, params) => {
      if (method !== "session/update") return;
      const notification = recordFrom(params);
      if (sessionId && notification?.sessionId !== sessionId) return;
      const update = recordFrom(notification?.update);
      const content = recordFrom(update?.content);
      if (update?.sessionUpdate === "agent_message_chunk" && content?.type === "text" && typeof content.text === "string" && content.text) ctx.onDelta(content.text);
    });
    // Registered before the first handshake byte, so a cancel or timeout
    // reaches a grok that stalls in authenticate.
    ctx.onCleanup(() => connection.terminate());
    const started = await openSession(connection, ctx.cwd, ctx.signal);
    sessionId = started.sessionId;
    const current = recordFrom(recordFrom(started.session)?.models)?.currentModelId;
    if (current !== ctx.model) await connection.request("session/set_model", { sessionId, modelId: ctx.model }, ctx.signal);
    return { connection, sessionId };
  },
  prompt: ({ connection, sessionId }, text, signal) =>
    connection.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, signal),
  cancel: ({ connection, sessionId }) => connection.notify("session/cancel", { sessionId }),
  tokens: outputTokensFrom,
};

function runGrok(input: AdapterRunInput): Promise<AdapterRunOutput> {
  return runSession(input, grokPlan);
}

export const grokAdapter = defineAdapter({
  id: "grok",
  name: "Grok",
  command: "grok",
}, {
  async probe(): Promise<AdapterProbeResult> {
    let version: string;
    try {
      const result = await runCommand("grok", ["--version"], { timeoutMs: PROBE_TIMEOUT_MS });
      if (result.code !== 0) throw new Error(result.output || `grok --version exited with code ${result.code}`);
      version = result.firstLine;
    } catch (error) {
      return probeFailure(error);
    }
    try {
      const listed = await discoverGrokModels();
      return {
        installed: true,
        authenticated: true,
        version,
        ...listed,
        ...(listed.models.length ? {} : { message: "Grok listed no models" }),
      };
    } catch (error) {
      // Only the agent's own error reply to authenticate says it is signed
      // out. A crash, a stall, or a refused initialize says nothing certain
      // about sign-in, and false would hide Grok from both UIs on a
      // transient failure. Either way there is no model list to offer: a
      // made-up one would only send the user into a lane that fails.
      if (error instanceof GrokRpcError && error.method === "authenticate") {
        return { installed: true, authenticated: false, version, models: [], message: error.message };
      }
      return probeFailure(error, version);
    }
  },

  run: runGrok,
});
