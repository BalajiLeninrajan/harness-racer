import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";

import type { ModelOption, ProviderInfo } from "../../shared/types.js";
import type { AdapterRunInput, AdapterRunOutput, HarnessAdapter } from "./types.js";

const COMMAND = "codex";
const REQUEST_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 120_000;

type RpcId = number | string;
type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface CodexModel {
  model: string;
  displayName: string;
  isDefault: boolean;
  hidden?: boolean;
}

interface InspectionResult {
  authenticated: boolean;
  models: ModelOption[];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (isObject(value) && typeof value.message === "string") return value.message;
  return String(value);
}

function makeAbortError(): Error {
  const error = new Error("Codex benchmark cancelled");
  error.name = "AbortError";
  return error;
}

function raceWithSignalAndTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  if (signal.aborted) return Promise.reject(makeAbortError());

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(new Error(timeoutMessage))), timeoutMs);
    timer.unref();

    const onAbort = () => finish(() => reject(makeAbortError()));
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      settle();
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function serverRequestResult(method: string): unknown {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "execCommandApproval":
      return { decision: "denied" };
    case "applyPatchApproval":
      return { decision: "denied" };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "item/tool/call":
      return {
        success: false,
        contentItems: [{ type: "inputText", text: "Tools are disabled during benchmarks." }],
      };
    default:
      return undefined;
  }
}

class CodexRpcClient {
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>();
  private readonly terminationListeners = new Set<(error: Error) => void>();
  private readonly lines: ReadlineInterface;
  private nextId = 1;
  private closed = false;
  private terminationError: Error | undefined;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.handleLine(line));
    // Drain stderr without forwarding it: app-server diagnostics can contain local paths or auth
    // details and are not safe to surface in browser-facing benchmark errors.
    child.stderr.resume();
    child.stdin.on("error", (error) => this.terminate(error));
    child.once("error", (error) => this.terminate(error));
    child.once("exit", (code, signal) => {
      if (this.closed) return;
      const detail = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
      this.terminate(new Error(`Codex app-server exited with ${detail}`));
    });
  }

  static async start(cwd: string): Promise<CodexRpcClient> {
    const child = spawn(COMMAND, ["app-server"], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new CodexRpcClient(child);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out starting Codex app-server"));
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        child.removeListener("spawn", onSpawn);
        child.removeListener("error", onError);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    }).catch((error) => {
      client.close();
      throw error;
    });

    return client;
  }

  request<T>(
    method: string,
    params: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.terminationError) return Promise.reject(this.terminationError);
    if (this.closed) return Promise.reject(new Error("Codex app-server is closed"));
    if (options.signal?.aborted) return Promise.reject(makeAbortError());

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        reject(new Error(`Codex app-server request '${method}' timed out`));
      }, timeoutMs);
      timer.unref();

      const onAbort = () => {
        this.pending.delete(id);
        cleanup();
        reject(makeAbortError());
      };
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value as T);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });

      this.write({ id, method, params }, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      this.write(params === undefined ? { method } : { method, params }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onTermination(listener: (error: Error) => void): () => void {
    if (this.terminationError) {
      listener(this.terminationError);
      return () => undefined;
    }
    this.terminationListeners.add(listener);
    return () => this.terminationListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.rejectPending(new Error("Codex app-server closed"));
    this.notificationListeners.clear();
    this.terminationListeners.clear();
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
      const forceKill = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
      }, 1_000);
      forceKill.unref();
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonObject;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isObject(parsed)) throw new Error("message is not an object");
      message = parsed;
    } catch (error) {
      this.terminate(new Error(`Invalid JSON from Codex app-server: ${errorMessage(error)}`));
      return;
    }

    const method = asString(message.method);
    const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : undefined;
    if (method && id !== undefined) {
      const result = serverRequestResult(method);
      if (result === undefined) {
        this.write({ id, error: { code: -32601, message: `Unsupported app-server request: ${method}` } });
      } else {
        this.write({ id, result });
      }
      return;
    }

    if (method) {
      for (const listener of this.notificationListeners) {
        try {
          listener(method, message.params);
        } catch (error) {
          this.terminate(error instanceof Error ? error : new Error(errorMessage(error)));
          break;
        }
      }
      return;
    }

    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.error !== undefined) {
      pending.reject(new Error(`Codex app-server error: ${errorMessage(message.error)}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private write(message: JsonObject, callback?: (error?: Error) => void): void {
    if (this.closed || !this.child.stdin.writable) {
      callback?.(new Error("Codex app-server stdin is closed"));
      return;
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => callback?.(error ?? undefined));
  }

  private terminate(error: Error): void {
    if (this.closed || this.terminationError) return;
    this.terminationError = error;
    this.rejectPending(this.terminationError);
    for (const listener of this.terminationListeners) listener(this.terminationError);
  }

  private rejectPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) request.reject(error);
  }
}

async function initialize(client: CodexRpcClient): Promise<string | undefined> {
  const response = await client.request<JsonObject>("initialize", {
    clientInfo: { name: "tps_racer", title: "TPS Racer", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  await client.notify("initialized");
  return asString(response.userAgent);
}

async function readModels(client: CodexRpcClient): Promise<ModelOption[]> {
  const models: ModelOption[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const response = await client.request<JsonObject>("model/list", cursor ? { cursor } : {});
    const data = Array.isArray(response.data) ? response.data : [];
    for (const raw of data) {
      if (!isObject(raw)) continue;
      const model = raw as unknown as CodexModel;
      if (typeof model.model !== "string" || typeof model.displayName !== "string") continue;
      if (model.hidden) continue;
      models.push({
        id: model.model,
        label: model.displayName,
        ...(model.isDefault ? { isDefault: true } : {}),
      });
    }
    const nextCursor = asString(response.nextCursor);
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  return models;
}

async function inspectCodex(cwd: string): Promise<InspectionResult> {
  const client = await CodexRpcClient.start(cwd);
  try {
    await initialize(client);
    const account = await client.request<JsonObject>("account/read", {});
    const authenticated = account.account != null || account.requiresOpenaiAuth !== true;
    return {
      authenticated,
      models: authenticated ? await readModels(client) : [],
    };
  } finally {
    client.close();
  }
}

function readVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(COMMAND, ["--version"], { timeout: 5_000 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const value = stdout.trim().replace(/^codex-cli\s+/i, "");
      resolve(value || stdout.trim());
    });
  });
}

async function interruptTurn(client: CodexRpcClient, threadId: string, turnId: string): Promise<void> {
  await Promise.race([
    client.request("turn/interrupt", { threadId, turnId }, { timeoutMs: 750 }).catch(() => undefined),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 800);
      timer.unref();
    }),
  ]);
}

export const codexAdapter: HarnessAdapter = {
  id: "codex",
  name: "Codex",
  command: COMMAND,

  async probe(): Promise<ProviderInfo> {
    let version: string;
    try {
      version = await readVersion();
    } catch (error) {
      const code = isObject(error) ? error.code : undefined;
      return {
        id: "codex",
        name: "Codex",
        command: COMMAND,
        installed: code !== "ENOENT",
        authenticated: null,
        models: [],
        message: code === "ENOENT" ? "Codex CLI is not installed" : errorMessage(error),
      };
    }

    try {
      const inspection = await inspectCodex(process.cwd());
      const defaultModel = inspection.models.find((model) => model.isDefault)?.id;
      return {
        id: "codex",
        name: "Codex",
        command: COMMAND,
        installed: true,
        authenticated: inspection.authenticated,
        version,
        models: inspection.models,
        ...(defaultModel ? { defaultModel } : {}),
        ...(!inspection.authenticated ? { message: "Sign in with the Codex CLI before benchmarking" } : {}),
      };
    } catch (error) {
      return {
        id: "codex",
        name: "Codex",
        command: COMMAND,
        installed: true,
        authenticated: null,
        version,
        models: [],
        message: errorMessage(error),
      };
    }
  },

  async listModels(): Promise<ModelOption[]> {
    return (await inspectCodex(process.cwd())).models;
  },

  async run(input: AdapterRunInput): Promise<AdapterRunOutput> {
    if (input.signal.aborted) throw makeAbortError();
    const client = await CodexRpcClient.start(input.cwd);
    let threadId: string | undefined;
    let turnId: string | undefined;
    let nativeOutputTokens: number | undefined;
    let removeNotificationListener: () => void = () => undefined;
    let removeTerminationListener: () => void = () => undefined;

    try {
      await initialize(client);
      const opened = await client.request<JsonObject>(
        "thread/start",
        {
          cwd: input.cwd,
          model: input.model,
          ephemeral: true,
          approvalPolicy: "never",
          sandbox: "read-only",
          developerInstructions:
            "This is a text streaming benchmark. Do not call tools or inspect files. Return only the text requested by the user.",
        },
        { signal: input.signal },
      );
      const thread = isObject(opened.thread) ? opened.thread : undefined;
      threadId = asString(thread?.id);
      if (!threadId) throw new Error("Codex app-server did not return a thread id");

      input.onReady();
      await raceWithSignalAndTimeout(
        input.waitForStart(),
        input.signal,
        RUN_TIMEOUT_MS,
        "Timed out waiting for the benchmark start barrier",
      );

      let resolveCompletion!: () => void;
      let rejectCompletion!: (error: Error) => void;
      const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      void completion.catch(() => undefined);

      removeTerminationListener = client.onTermination(rejectCompletion);
      removeNotificationListener = client.onNotification((method, rawParams) => {
        if (!isObject(rawParams)) return;
        const eventThreadId = asString(rawParams.threadId);
        if (eventThreadId && eventThreadId !== threadId) return;

        if (method === "item/agentMessage/delta") {
          const eventTurnId = asString(rawParams.turnId);
          if (turnId && eventTurnId && eventTurnId !== turnId) return;
          const delta = asString(rawParams.delta);
          if (delta) input.onDelta(delta);
          return;
        }

        if (method === "thread/tokenUsage/updated") {
          const eventTurnId = asString(rawParams.turnId);
          if (turnId && eventTurnId && eventTurnId !== turnId) return;
          const usage = isObject(rawParams.tokenUsage) ? rawParams.tokenUsage : undefined;
          const last = usage && isObject(usage.last) ? usage.last : undefined;
          if (typeof last?.outputTokens === "number") nativeOutputTokens = last.outputTokens;
          return;
        }

        if (method === "error" && rawParams.willRetry !== true) {
          const details = isObject(rawParams.error) ? rawParams.error : rawParams;
          rejectCompletion(new Error(asString(details.message) ?? "Codex turn failed"));
          return;
        }

        if (method !== "turn/completed") return;
        const turn = isObject(rawParams.turn) ? rawParams.turn : undefined;
        const completedTurnId = asString(turn?.id);
        if (turnId && completedTurnId && completedTurnId !== turnId) return;
        const status = asString(turn?.status);
        if (status === "completed") {
          resolveCompletion();
          return;
        }
        const turnError = turn && isObject(turn.error) ? turn.error : undefined;
        rejectCompletion(
          new Error(asString(turnError?.message) ?? `Codex turn ${status ?? "failed"}`),
        );
      });

      const started = await client.request<JsonObject>(
        "turn/start",
        {
          threadId,
          model: input.model,
          input: [{ type: "text", text: input.prompt }],
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly" },
        },
        { signal: input.signal, timeoutMs: RUN_TIMEOUT_MS },
      );
      const turn = isObject(started.turn) ? started.turn : undefined;
      turnId = asString(turn?.id);
      if (!turnId) throw new Error("Codex app-server did not return a turn id");

      await raceWithSignalAndTimeout(
        completion,
        input.signal,
        RUN_TIMEOUT_MS,
        "Codex benchmark turn timed out",
      );
      return nativeOutputTokens === undefined ? {} : { nativeOutputTokens };
    } catch (error) {
      if (threadId && turnId && input.signal.aborted) await interruptTurn(client, threadId, turnId);
      throw error;
    } finally {
      removeNotificationListener();
      removeTerminationListener();
      client.close();
    }
  },
};

export default codexAdapter;
