import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { ModelOption } from "../../shared/types.js";
import { errorMessage, outputTokensFrom, recordFrom, stringFrom, stripAnsi, type JsonRecord } from "./lib/json.js";
import { bounded, normalizeModels, notInstalled, probeFailure, type ModelList } from "./lib/probe.js";
import { runCommand } from "./lib/process.js";
import { runSession, type SessionPlan } from "./lib/run.js";
import { defineAdapter, type AdapterProbeResult, type AdapterRunInput, type AdapterRunOutput } from "./types.js";

const CURSOR_COMMANDS = ["agent", "cursor-agent"] as const;
// One-shot commands (--version, status) and the ACP model discovery each get
// this long before the probe gives up on them.
const PROBE_TIMEOUT_MS = 20_000;

// The binary the last probe found. The run path reads it so a lane does not
// spend its prep on a --version round trip; every probe resolves it afresh,
// so a binary that vanishes is noticed the next time the list is read.
let resolvedCommand: string | undefined;

/**
 * Finds the installed Cursor binary by name, trying `agent` first. A binary
 * that is present but fails or stalls on --version outranks one that is
 * absent, and its own failure is what gets thrown: the fixed "not installed"
 * message is only right when every candidate was missing from PATH.
 */
async function resolveCursorCommand(): Promise<{ command: string; version: string }> {
  let lastError: unknown;
  for (const candidate of CURSOR_COMMANDS) {
    try {
      const result = await runCommand(candidate, ["--version"], { timeoutMs: PROBE_TIMEOUT_MS });
      if (result.code === 0) {
        resolvedCommand = candidate;
        return { command: candidate, version: result.firstLine };
      }
      lastError = new Error(`${candidate} --version exited with code ${result.code}${result.output ? `: ${result.output}` : ""}`);
    } catch (error) {
      if (!notInstalled(error) || lastError === undefined) lastError = error;
    }
  }
  resolvedCommand = undefined;
  if (lastError === undefined || notInstalled(lastError)) {
    throw new Error("Cursor Agent is not installed or is not available on PATH", { cause: lastError });
  }
  throw lastError;
}

async function cursorCommand(): Promise<string> {
  return resolvedCommand ?? (await resolveCursorCommand()).command;
}

function modelFromRecord(value: unknown): ModelOption | undefined {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id, label: id } : undefined;
  }
  const record = recordFrom(value);
  if (!record) return undefined;
  const id = stringFrom(record.id) ?? stringFrom(record.model) ?? stringFrom(record.slug) ?? stringFrom(record.value);
  if (!id) return undefined;
  const label = stringFrom(record.label) ?? stringFrom(record.name) ?? id;
  const isDefault = record.isDefault === true || record.default === true || record.selected === true;
  return { id, label, ...(isDefault ? { isDefault: true } : {}) };
}

function modelsFromJson(value: unknown): ModelOption[] {
  if (Array.isArray(value)) return value.map(modelFromRecord).filter((model): model is ModelOption => Boolean(model));
  const record = recordFrom(value);
  if (!record) return [];
  for (const key of ["models", "data", "items", "availableModels"]) {
    if (Array.isArray(record[key])) return modelsFromJson(record[key]);
  }
  const single = modelFromRecord(record);
  return single ? [single] : [];
}

function configOptionsFrom(value: unknown): JsonRecord[] {
  const options = recordFrom(value)?.configOptions;
  return Array.isArray(options) ? options.map(recordFrom).filter((option): option is JsonRecord => Boolean(option)) : [];
}

function findConfigOption(value: unknown, category: string): JsonRecord | undefined {
  return configOptionsFrom(value).find((option) => option.category === category);
}

function configOptionValues(option: JsonRecord | undefined): string[] {
  if (!option || !Array.isArray(option.options)) return [];
  const values: string[] = [];
  for (const rawEntry of option.options) {
    const entry = recordFrom(rawEntry);
    if (!entry) continue;
    if (typeof entry.value === "string") values.push(entry.value);
    if (!Array.isArray(entry.options)) continue;
    for (const rawNested of entry.options) {
      const nested = recordFrom(rawNested);
      if (typeof nested?.value === "string") values.push(nested.value);
    }
  }
  return values;
}

function currentConfigValue(option: JsonRecord | undefined): string | undefined {
  return typeof option?.currentValue === "string" ? option.currentValue : undefined;
}

function concreteCurrentModel(session: unknown): string | undefined {
  const configured = currentConfigValue(findConfigOption(session, "model"));
  if (configured && configured !== "default" && configured !== "auto") return configured;
  const modelState = recordFrom(recordFrom(session)?.models);
  const current = typeof modelState?.currentModelId === "string" ? modelState.currentModelId : undefined;
  return current && current !== "default" && current !== "auto" ? current : undefined;
}

function rpcError(method: string, error: unknown): Error {
  const record = recordFrom(error);
  if (!record) return new Error(`Cursor ACP ${method} failed`);
  const detail = typeof record.message === "string" ? record.message : JSON.stringify(error);
  return new Error(`Cursor ACP ${method} failed: ${detail}`);
}

class CursorAcpConnection {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private closed = false;
  private readonly pending = new Map<number, {
    method: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();

  constructor(
    command: string,
    cwd: string,
    private readonly onNotification: (method: string, params: unknown) => void,
  ) {
    this.child = spawn(command, ["acp"], {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.acceptChunk(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-16_384);
    });
    this.child.once("error", (error) => this.failAll(error));
    // A write that lands after the child closed its read end raises EPIPE on
    // stdin; without a listener that is an uncaught exception.
    this.child.stdin.on("error", (error) => this.failAll(error));
    this.child.once("close", (code, signal) => {
      this.closed = true;
      const detail = stripAnsi(this.stderr).trim();
      this.failAll(new Error(
        `Cursor ACP exited with ${signal ? `signal ${signal}` : `code ${code}`}${detail ? `: ${detail}` : ""}`,
      ));
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Cursor ACP process is closed"));
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
    let message: JsonRecord | undefined;
    try {
      message = recordFrom(JSON.parse(line));
    } catch {
      return;
    }
    if (!message) return;

    if (typeof message.id === "number" && ("result" in message || "error" in message) && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) pending.reject(rpcError(pending.method, message.error));
      else pending.resolve(message.result);
      return;
    }

    if (typeof message.method !== "string") return;
    if (message.id !== undefined) {
      this.handleAgentRequest(message);
      return;
    }
    this.onNotification(message.method, message.params);
  }

  private handleAgentRequest(message: JsonRecord): void {
    if (message.method === "session/request_permission") {
      const params = recordFrom(message.params) ?? {};
      const options = Array.isArray(params.options) ? params.options : [];
      const rejectOption = options.map(recordFrom).find((option) => String(option?.kind).startsWith("reject"));
      const optionId = stringFrom(rejectOption?.optionId);
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        result: optionId
          ? { outcome: { outcome: "selected", optionId } }
          : { outcome: { outcome: "cancelled" } },
      });
      return;
    }
    this.write({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Client method not supported: ${message.method}` },
    });
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function handshake(connection: CursorAcpConnection, cwd: string, clientName: string): Promise<unknown> {
  await connection.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      _meta: { parameterizedModelPicker: true },
    },
    clientInfo: { name: clientName, version: "0.1.0" },
  });
  await connection.request("authenticate", { methodId: "cursor_login" });
  return connection.request("session/new", { cwd, mcpServers: [] });
}

async function listModels(connection: CursorAcpConnection, cwd: string): Promise<ModelList> {
  const session = await handshake(connection, cwd, "harness-racer-model-probe");
  const response = await connection.request("cursor/list_available_models", {});
  const models = modelsFromJson(response).filter((model) => model.id !== "auto" && model.id !== "default");
  return normalizeModels(models, concreteCurrentModel(session));
}

async function discoverCursorModels(command: string): Promise<ModelList> {
  const connection = new CursorAcpConnection(command, process.cwd(), () => {});
  try {
    // request() takes no signal, so the bound ends the process instead; its
    // close rejects whatever the handshake is waiting on.
    return await bounded(
      listModels(connection, process.cwd()),
      PROBE_TIMEOUT_MS,
      `Cursor ACP model discovery did not finish within ${Math.round(PROBE_TIMEOUT_MS / 1000)}s`,
      () => connection.terminate(),
    );
  } finally {
    connection.terminate();
  }
}

interface CursorSession {
  connection: CursorAcpConnection;
  sessionId: string;
}

const cursorPlan: SessionPlan<CursorSession> = {
  async open(ctx) {
    const command = await cursorCommand();
    let sessionId: string | undefined;
    const connection = new CursorAcpConnection(command, ctx.cwd, (method, params) => {
      if (method !== "session/update") return;
      const notification = recordFrom(params);
      if (sessionId && notification?.sessionId !== sessionId) return;
      const update = recordFrom(notification?.update);
      const content = recordFrom(update?.content);
      if (update?.sessionUpdate === "agent_message_chunk" && content?.type === "text" && typeof content.text === "string" && content.text) ctx.onDelta(content.text);
    });
    ctx.onCleanup(() => connection.terminate());

    const created = await handshake(connection, ctx.cwd, "harness-racer");
    sessionId = stringFrom(recordFrom(created)?.sessionId);
    if (!sessionId) throw new Error("Cursor ACP session/new returned no sessionId");
    if (ctx.model === "auto" || ctx.model === "default") {
      throw new Error("Cursor Auto is dynamic and cannot be used for an attributable speed benchmark. Select a concrete model.");
    }
    const modelConfig = findConfigOption(created, "model");
    const modelConfigId = stringFrom(modelConfig?.id) ?? "model";
    const availableModels = configOptionValues(modelConfig);
    if (availableModels.length > 0 && !availableModels.includes(ctx.model)) {
      throw new Error(`Cursor ACP does not advertise model ${ctx.model}. Refresh the model list and choose a concrete model.`);
    }
    let configured: unknown;
    try {
      configured = await connection.request("session/set_config_option", {
        sessionId,
        configId: modelConfigId,
        value: ctx.model,
      });
    } catch (error) {
      throw new Error(`Cursor could not select model ${ctx.model}`, { cause: error });
    }
    const selectedValue = currentConfigValue(findConfigOption(configured, "model"));
    if (selectedValue && selectedValue !== ctx.model) {
      throw new Error(`Cursor selected ${selectedValue} instead of requested model ${ctx.model}`);
    }
    try {
      await connection.request("session/set_config_option", {
        sessionId,
        configId: "mode",
        value: "ask",
      });
    } catch (error) {
      throw new Error("Cursor could not enter read-only ask mode", { cause: error });
    }
    return { connection, sessionId };
  },
  prompt: ({ connection, sessionId }, text) =>
    connection.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }),
  cancel: ({ connection, sessionId }) => connection.notify("session/cancel", { sessionId }),
  tokens: outputTokensFrom,
};

function runCursor(input: AdapterRunInput): Promise<AdapterRunOutput> {
  return runSession(input, cursorPlan);
}

export const cursorAdapter = defineAdapter({
  id: "cursor",
  name: "Cursor",
  command: "agent",
}, {
  async probe(): Promise<AdapterProbeResult> {
    let command: string;
    let version: string;
    try {
      ({ command, version } = await resolveCursorCommand());
    } catch (error) {
      return probeFailure(error);
    }

    let authenticated: boolean | null;
    let statusMessage: string | undefined;
    try {
      const status = await runCommand(command, ["status", "--format", "json"], { timeoutMs: PROBE_TIMEOUT_MS });
      authenticated = status.code === 0 ? true : null;
      try {
        const parsed = recordFrom(JSON.parse(status.stdout)) ?? {};
        const explicit = parsed.loggedIn ?? parsed.authenticated ?? parsed.isAuthenticated;
        if (typeof explicit === "boolean") authenticated = explicit;
      } catch {
        const statusText = `${status.stdout}\n${status.stderr}`;
        if (/not\s+(?:logged|signed)\s+in|unauthenticated|login required/i.test(statusText)) authenticated = false;
      }
      if (status.code !== 0) statusMessage = stripAnsi(status.stderr || status.stdout).trim();
    } catch (error) {
      return probeFailure(error, version);
    }

    // Without a model list Cursor is not runnable, and the reason is the
    // message: the old "default" stand-in was an id the run path refuses.
    let listed: ModelList = { models: [] };
    let modelMessage: string | undefined;
    if (authenticated !== false) {
      try {
        listed = await discoverCursorModels(command);
      } catch (error) {
        modelMessage = errorMessage(error);
      }
    }

    return {
      installed: true,
      authenticated,
      version,
      ...listed,
      message: modelMessage ?? statusMessage ?? undefined,
    };
  },

  run: runCursor,
});
