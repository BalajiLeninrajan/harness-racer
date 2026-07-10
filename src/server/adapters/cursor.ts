import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { ModelOption } from "../../shared/types.js";
import { defineAdapter, type AdapterProbeResult, type AdapterRunInput, type AdapterRunOutput } from "./types.js";

const CURSOR_COMMANDS = ["agent", "cursor-agent"] as const;
const FALLBACK_MODELS: ModelOption[] = [
  { id: "default", label: "Cursor Auto (dynamic)" },
];

let resolvedCommand: string | undefined;

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

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function messageFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function runCommand(command: string, args: string[], cwd?: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function cursorCommand(): Promise<string> {
  if (resolvedCommand) return resolvedCommand;

  let lastError: unknown;
  for (const candidate of CURSOR_COMMANDS) {
    try {
      const result = await runCommand(candidate, ["--version"]);
      if (result.code === 0) {
        resolvedCommand = candidate;
        return candidate;
      }
    } catch (error) {
      lastError = error;
    }
  }

  const error = new Error("Cursor Agent is not installed or is not available on PATH");
  if (lastError) (error as Error & { cause?: unknown }).cause = lastError;
  throw error;
}

function modelFromRecord(value: unknown): ModelOption | undefined {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id, label: id } : undefined;
  }
  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  const id = messageFrom(record.id) ?? messageFrom(record.model) ?? messageFrom(record.slug) ?? messageFrom(record.value);
  if (!id) return undefined;
  const label = messageFrom(record.label) ?? messageFrom(record.name) ?? id;
  const isDefault = record.isDefault === true || record.default === true || record.selected === true;
  return { id, label, ...(isDefault ? { isDefault: true } : {}) };
}

function modelsFromJson(value: unknown): ModelOption[] {
  if (Array.isArray(value)) return value.map(modelFromRecord).filter((model): model is ModelOption => Boolean(model));
  if (!value || typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  for (const key of ["models", "data", "items", "availableModels"]) {
    if (Array.isArray(record[key])) return modelsFromJson(record[key]);
  }
  const single = modelFromRecord(record);
  return single ? [single] : [];
}

type JsonRecord = Record<string, unknown>;

function recordFrom(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
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

function outputTokensFrom(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as JsonRecord;
  for (const candidate of [record.outputTokens, record.output_tokens, record.completionTokens, record.completion_tokens]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  for (const nested of [record.usage, record.tokenUsage, record.result]) {
    const tokens = outputTokensFrom(nested);
    if (tokens !== undefined) return tokens;
  }
  return undefined;
}

function rpcError(method: string, error: unknown): Error {
  if (!error || typeof error !== "object") return new Error(`Cursor ACP ${method} failed`);
  const record = error as JsonRecord;
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
    let message: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") return;
      message = parsed as JsonRecord;
    } catch {
      return;
    }

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
      const params = message.params && typeof message.params === "object" ? message.params as JsonRecord : {};
      const options = Array.isArray(params.options) ? params.options : [];
      const rejectOption = options.find((option) => {
        if (!option || typeof option !== "object") return false;
        return String((option as JsonRecord).kind).startsWith("reject");
      }) as JsonRecord | undefined;
      const optionId = rejectOption && typeof rejectOption.optionId === "string" ? rejectOption.optionId : undefined;
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

interface CursorDiscovery {
  models: ModelOption[];
  defaultModel?: string;
}

async function discoverCursorModels(): Promise<CursorDiscovery> {
  const command = await cursorCommand();
  const connection = new CursorAcpConnection(command, process.cwd(), () => {});
  try {
    await connection.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        _meta: { parameterizedModelPicker: true },
      },
      clientInfo: { name: "tps-racer-model-probe", version: "0.1.0" },
    });
    await connection.request("authenticate", { methodId: "cursor_login" });
    const session = await connection.request("session/new", { cwd: process.cwd(), mcpServers: [] });
    const response = await connection.request("cursor/list_available_models", {});
    const discovered = modelsFromJson(response)
      .filter((model) => model.id !== "auto" && model.id !== "default");
    const models = [...new Map(discovered.map((model) => [model.id, model])).values()];
    const current = concreteCurrentModel(session);
    const defaultModel = current && models.some((model) => model.id === current)
      ? current
      : models[0]?.id;
    return {
      models: models.map((model) => ({
        ...model,
        ...(model.id === defaultModel ? { isDefault: true } : {}),
      })),
      defaultModel,
    };
  } finally {
    connection.terminate();
  }
}

async function runCursor(input: AdapterRunInput): Promise<AdapterRunOutput> {
  if (input.signal.aborted) throw abortError();
  let readySignaled = false;
  let sessionId: string | undefined;
  let connection: CursorAcpConnection | undefined;
  const signalReady = () => {
    if (readySignaled) return;
    readySignaled = true;
    input.onReady();
  };

  try {
    const command = await cursorCommand();
    connection = new CursorAcpConnection(command, input.cwd, (method, params) => {
      if (method !== "session/update" || !params || typeof params !== "object") return;
      const notification = params as JsonRecord;
      if (sessionId && notification.sessionId !== sessionId) return;
      if (!notification.update || typeof notification.update !== "object") return;
      const update = notification.update as JsonRecord;
      if (update.sessionUpdate !== "agent_message_chunk" || !update.content || typeof update.content !== "object") return;
      const content = update.content as JsonRecord;
      if (content.type === "text" && typeof content.text === "string" && content.text) input.onDelta(content.text);
    });

    const onAbort = () => {
      if (sessionId) connection?.notify("session/cancel", { sessionId });
      connection?.terminate();
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await connection.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          _meta: { parameterizedModelPicker: true },
        },
        clientInfo: { name: "tps-racer", version: "0.1.0" },
      });
      await connection.request("authenticate", { methodId: "cursor_login" });
      const created = await connection.request("session/new", { cwd: input.cwd, mcpServers: [] });
      if (!created || typeof created !== "object" || typeof (created as JsonRecord).sessionId !== "string") {
        throw new Error("Cursor ACP session/new returned no sessionId");
      }
      sessionId = (created as JsonRecord).sessionId as string;
      if (input.model === "auto" || input.model === "default") {
        throw new Error("Cursor Auto is dynamic and cannot be used for an attributable speed benchmark. Select a concrete model.");
      }
      const modelConfig = findConfigOption(created, "model");
      const modelConfigId = typeof modelConfig?.id === "string" && modelConfig.id.trim()
        ? modelConfig.id.trim()
        : "model";
      const availableModels = configOptionValues(modelConfig);
      if (availableModels.length > 0 && !availableModels.includes(input.model)) {
        throw new Error(`Cursor ACP does not advertise model ${input.model}. Refresh the model list and choose a concrete model.`);
      }
      let configured: unknown;
      try {
        configured = await connection.request("session/set_config_option", {
          sessionId,
          configId: modelConfigId,
          value: input.model,
        });
      } catch (error) {
        throw new Error(`Cursor could not select model ${input.model}`, { cause: error });
      }
      const selectedValue = currentConfigValue(findConfigOption(configured, "model"));
      if (selectedValue && selectedValue !== input.model) {
        throw new Error(`Cursor selected ${selectedValue} instead of requested model ${input.model}`);
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

      signalReady();
      await input.waitForStart();
      if (input.signal.aborted) throw abortError();

      const result = await connection.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: input.prompt }],
      });
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

export const cursorAdapter = defineAdapter({
  id: "cursor",
  name: "Cursor",
  command: "agent",
}, {
  async probe(): Promise<AdapterProbeResult> {
    let command: string;
    try {
      command = await cursorCommand();
    } catch (error) {
      return {
        installed: false,
        authenticated: null,
        message: error instanceof Error ? error.message : String(error),
        models: [],
      };
    }

    const [versionResult, statusResult] = await Promise.all([
      runCommand(command, ["--version"]),
      runCommand(command, ["status", "--format", "json"]),
    ]);
    let authenticated: boolean | null = statusResult.code === 0 ? true : null;
    try {
      const status = JSON.parse(statusResult.stdout) as Record<string, unknown>;
      const explicit = status.loggedIn ?? status.authenticated ?? status.isAuthenticated;
      if (typeof explicit === "boolean") authenticated = explicit;
    } catch {
      const statusText = `${statusResult.stdout}\n${statusResult.stderr}`;
      if (/not\s+(?:logged|signed)\s+in|unauthenticated|login required/i.test(statusText)) authenticated = false;
    }

    let models: ModelOption[] = [];
    let defaultModel: string | undefined;
    let modelMessage: string | undefined;
    if (authenticated !== false) {
      try {
        const discovery = await discoverCursorModels();
        models = discovery.models;
        defaultModel = discovery.defaultModel;
      } catch (error) {
        modelMessage = error instanceof Error ? error.message : String(error);
      }
    }
    if (models.length === 0) models = FALLBACK_MODELS.map((model) => ({ ...model }));
    defaultModel ??= models.find((model) => model.isDefault)?.id ?? models[0]?.id;
    const statusMessage = statusResult.code === 0 ? undefined : stripAnsi(statusResult.stderr || statusResult.stdout).trim();

    return {
      installed: true,
      authenticated,
      version: stripAnsi(versionResult.stdout || versionResult.stderr).trim().split(/\r?\n/)[0],
      models,
      defaultModel,
      message: modelMessage ?? statusMessage ?? undefined,
    };
  },

  run: runCursor,
});
