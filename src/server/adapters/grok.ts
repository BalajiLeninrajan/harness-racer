import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { ModelOption, ProviderInfo } from "../../shared/types.js";
import type { AdapterRunInput, AdapterRunOutput, HarnessAdapter } from "./types.js";

type JsonRecord = Record<string, unknown>;

function recordFrom(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function abortError(): Error {
  const error = new Error("Benchmark cancelled");
  error.name = "AbortError";
  return error;
}

function outputTokensFrom(value: unknown): number | undefined {
  const record = recordFrom(value);
  if (!record) return undefined;
  for (const candidate of [record.outputTokens, record.output_tokens]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  for (const nested of [record.usage, record.result]) {
    const tokens = outputTokensFrom(nested);
    if (tokens !== undefined) return tokens;
  }
  return undefined;
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
    this.child.once("close", (code, signal) => {
      this.closed = true;
      this.failAll(new Error(`Grok ACP exited with ${signal ? `signal ${signal}` : `code ${code}`}${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`));
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Grok ACP process is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
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
      if (message.error !== undefined) {
        const detail = recordFrom(message.error)?.message;
        pending.reject(new Error(`Grok ACP ${pending.method} failed${typeof detail === "string" ? `: ${detail}` : ""}`));
      } else pending.resolve(message.result);
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

function modelsFromSession(session: unknown): { models: ModelOption[]; defaultModel?: string } {
  const modelState = recordFrom(recordFrom(session)?.models);
  const available = Array.isArray(modelState?.availableModels) ? modelState.availableModels : [];
  const current = typeof modelState?.currentModelId === "string" ? modelState.currentModelId : undefined;
  const models = available.flatMap((value): ModelOption[] => {
    const model = recordFrom(value);
    const id = typeof model?.modelId === "string" ? model.modelId.trim() : "";
    if (!id) return [];
    const label = typeof model?.name === "string" && model.name.trim() ? model.name.trim() : id;
    return [{ id, label, ...(id === current ? { isDefault: true } : {}) }];
  });
  if (!models.length) models.push({ id: "grok-build", label: "Grok Build", isDefault: true });
  return { models, defaultModel: current ?? models[0]?.id };
}

async function startSession(cwd: string, onNotification: (method: string, params: unknown) => void) {
  const connection = new GrokAcpConnection(cwd, onNotification);
  await connection.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "tps-racer", version: "0.1.0" },
  });
  await connection.request("authenticate", { methodId: process.env.XAI_API_KEY?.trim() ? "xai.api_key" : "cached_token" });
  const session = await connection.request("session/new", { cwd, mcpServers: [] });
  const sessionId = recordFrom(session)?.sessionId;
  if (typeof sessionId !== "string") throw new Error("Grok ACP session/new returned no sessionId");
  return { connection, session, sessionId };
}

async function discoverGrokModels(): Promise<{ models: ModelOption[]; defaultModel?: string }> {
  const started = await startSession(process.cwd(), () => {});
  try {
    return modelsFromSession(started.session);
  } finally {
    started.connection.terminate();
  }
}

async function runGrok(input: AdapterRunInput): Promise<AdapterRunOutput> {
  if (input.signal.aborted) throw abortError();
  let sessionId: string | undefined;
  let connection: GrokAcpConnection | undefined;
  let ready = false;
  const signalReady = () => {
    if (!ready) {
      ready = true;
      input.onReady();
    }
  };
  try {
    const started = await startSession(input.cwd, (method, params) => {
      if (method !== "session/update") return;
      const notification = recordFrom(params);
      if (sessionId && notification?.sessionId !== sessionId) return;
      const update = recordFrom(notification?.update);
      const content = recordFrom(update?.content);
      if (update?.sessionUpdate === "agent_message_chunk" && content?.type === "text" && typeof content.text === "string" && content.text) input.onDelta(content.text);
    });
    connection = started.connection;
    sessionId = started.sessionId;
    const current = recordFrom(recordFrom(started.session)?.models)?.currentModelId;
    if (current !== input.model) await connection.request("session/set_model", { sessionId, modelId: input.model });
    const onAbort = () => {
      connection?.notify("session/cancel", { sessionId });
      connection?.terminate();
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    signalReady();
    await input.waitForStart();
    if (input.signal.aborted) throw abortError();
    try {
      const result = await connection.request("session/prompt", { sessionId, prompt: [{ type: "text", text: input.prompt }] });
      const nativeOutputTokens = outputTokensFrom(result);
      return nativeOutputTokens === undefined ? {} : { nativeOutputTokens };
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
  } catch (error) {
    signalReady();
    if (input.signal.aborted) throw abortError();
    throw error;
  } finally {
    connection?.terminate();
  }
}

export const grokAdapter: HarnessAdapter = {
  id: "grok",
  name: "Grok",
  command: "grok",

  async probe(): Promise<ProviderInfo> {
    let version = "";
    try {
      const child = spawn("grok", ["--version"], { env: process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { output += chunk; });
      child.stderr.on("data", (chunk: string) => { output += chunk; });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      if (code !== 0) throw new Error(output.trim() || `Grok exited with code ${code}`);
      version = output.trim().split(/\r?\n/)[0] ?? "";
    } catch (error) {
      return {
        id: "grok",
        name: "Grok",
        command: "grok",
        installed: false,
        authenticated: null,
        models: [],
        message: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      const discovery = await discoverGrokModels();
      return {
        id: "grok",
        name: "Grok",
        command: "grok",
        installed: true,
        authenticated: true,
        version,
        models: discovery.models,
        defaultModel: discovery.defaultModel,
      };
    } catch (error) {
      return {
        id: "grok",
        name: "Grok",
        command: "grok",
        installed: true,
        authenticated: false,
        version,
        models: [{ id: "grok-build", label: "Grok Build", isDefault: true }],
        defaultModel: "grok-build",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },

  async listModels(): Promise<ModelOption[]> {
    return (await discoverGrokModels()).models;
  },

  run: runGrok,
};
