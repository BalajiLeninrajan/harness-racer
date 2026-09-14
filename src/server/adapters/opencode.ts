import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";

import type { ModelOption } from "../../shared/types.js";
import { errorMessage, recordFrom } from "./lib/json.js";
import { bounded, normalizeModels, probeFailure, type ModelList } from "./lib/probe.js";
import { runCommand } from "./lib/process.js";
import { abortError, runSession, type SessionPlan } from "./lib/run.js";
import { defineAdapter, type AdapterProbeResult, type AdapterRunInput, type AdapterRunOutput } from "./types.js";

// The --version spawn and the provider listing each get this long before the
// probe gives up on them. The server's own start is bounded separately below.
const PROBE_TIMEOUT_MS = 20_000;

interface OpenCodeProcess {
  child: ChildProcess;
  url: string;
  // The tail of what the server has written to stderr so far.
  stderr: () => string;
  terminate: () => void;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      server.close(() => port ? resolve(port) : reject(new Error("Could not allocate an OpenCode port")));
    });
  });
}

// `onSpawn` receives the kill as soon as the server process exists, before
// the wait for it to answer, so a run given up on during that wait can end it.
async function startOpenCode(cwd: string, onSpawn?: (terminate: () => void) => void): Promise<OpenCodeProcess> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn("opencode", ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
    cwd,
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-16_384); });
  let terminating = false;
  const terminate = () => {
    if (terminating || child.exitCode !== null || child.signalCode !== null) return;
    terminating = true;
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 1_500);
    timer.unref();
  };
  onSpawn?.(terminate);
  await new Promise<void>((resolve, reject) => {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      void fetch(`${url}/provider`).then((response) => {
        if (!response.ok) return;
        clearInterval(timer);
        resolve();
      }).catch(() => {});
      if (attempts >= 50) {
        clearInterval(timer);
        terminate();
        reject(new Error(`OpenCode server did not start${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
      }
    }, 100);
    child.once("error", (error) => {
      clearInterval(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearInterval(timer);
      reject(new Error(`OpenCode server exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });
  });
  return { child, url, stderr: () => stderr.trim(), terminate };
}

function parseModelId(value: string): { providerID: string; modelID: string } {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) throw new Error(`Invalid OpenCode model id: ${value}`);
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) };
}

async function loadInventory(cwd: string): Promise<ModelList> {
  const server = await startOpenCode(cwd);
  const deadline = new AbortController();
  try {
    const client = createOpencodeClient({ baseUrl: server.url, directory: cwd });
    const response = await bounded(
      client.provider.list({ directory: cwd }, { signal: deadline.signal }),
      PROBE_TIMEOUT_MS,
      `OpenCode provider listing did not finish within ${Math.round(PROBE_TIMEOUT_MS / 1000)}s`,
      () => {
        deadline.abort();
        server.terminate();
      },
    );
    if (!response.data) throw new Error(`OpenCode provider discovery failed: ${JSON.stringify(response.error)}`);
    const connected = new Set(response.data.connected);
    const models: ModelOption[] = [];
    for (const provider of response.data.all) {
      if (!connected.has(provider.id)) continue;
      for (const model of Object.values(provider.models)) {
        models.push({ id: `${provider.id}/${model.id}`, label: model.name || model.id });
      }
    }
    const defaultEntry = Object.entries(response.data.default).find(([providerID]) => connected.has(providerID));
    return normalizeModels(models, defaultEntry ? `${defaultEntry[0]}/${defaultEntry[1]}` : undefined);
  } finally {
    server.terminate();
  }
}

interface OpenCodeSession {
  client: ReturnType<typeof createOpencodeClient>;
  cwd: string;
  sessionId: string;
  model: { providerID: string; modelID: string };
  onDelta: (text: string) => void;
  // The event stream, already pulled once: `first` is the event that proved
  // it live, and the prompt's events follow it.
  iterator: AsyncIterator<unknown>;
  first: IteratorResult<unknown>;
  streamFailure: (message: string) => Error;
}

const openCodePlan: SessionPlan<OpenCodeSession, void> = {
  async open(ctx) {
    // Registered before the server is spawned, so a cancel during setup stops
    // the SSE stream and kills the server instead of waiting for session.create.
    const controller = new AbortController();
    ctx.onCleanup(() => controller.abort());
    const server = await startOpenCode(ctx.cwd, ctx.onCleanup);
    if (ctx.signal.aborted) throw abortError();
    const client = createOpencodeClient({ baseUrl: server.url, directory: ctx.cwd });
    const model = parseModelId(ctx.model);
    const created = await client.session.create({
      directory: ctx.cwd,
      title: "Harness Racer benchmark",
      model: { id: model.modelID, providerID: model.providerID },
      permission: [{ permission: "*", pattern: "*", action: "deny" }],
    }, { signal: ctx.signal });
    if (!created.data) throw new Error(`OpenCode session creation failed: ${JSON.stringify(created.error)}`);
    const sessionId = created.data.id;
    // The SDK counts the first connection as an attempt, so 1 means no
    // reconnects: a server that dies ends the stream instead of being retried
    // with backoff until the run times out. The SDK only hands the failure to
    // onSseError before ending the stream, so it is kept for the error.
    let sseError: unknown;
    const subscription = await client.event.subscribe({ directory: ctx.cwd }, {
      signal: controller.signal,
      sseMaxRetryAttempts: 1,
      onSseError: (error) => { sseError = error; },
    });
    const streamFailure = (message: string) => {
      const details = [
        ...(sseError !== undefined ? [`stream error: ${errorMessage(sseError)}`] : []),
        ...(server.stderr() ? [`server stderr: ${server.stderr()}`] : []),
      ];
      return new Error(`${message}${details.length ? ` (${details.join("; ")})` : ""}`);
    };
    // The stream is a lazy generator: nothing connects to /event until it is
    // first pulled. The server acknowledges a new subscriber with
    // server.connected, so the first event is the proof that the stream is
    // live, and any event the prompt produces after this point is delivered.
    const iterator = subscription.stream[Symbol.asyncIterator]();
    // Leaving the loop early leaves the generator suspended at a yield;
    // returning it runs the SDK's cleanup of the response reader.
    ctx.onCleanup(() => void iterator.return?.().catch(() => undefined));
    const first = await iterator.next();
    if (first.done) throw streamFailure("OpenCode event stream could not be opened");
    return { client, cwd: ctx.cwd, sessionId, model, onDelta: ctx.onDelta, iterator, first, streamFailure };
  },

  async prompt(session, text, signal) {
    const { client, cwd, sessionId, iterator, onDelta } = session;
    const roles = new Map<string, string>();
    const emitted = new Map<string, string>();
    let idle = false;
    const prompt = await client.session.promptAsync({
      sessionID: sessionId,
      directory: cwd,
      model: session.model,
      tools: {},
      parts: [{ type: "text", text }],
    }, { signal });
    if (prompt.error) throw new Error(`OpenCode prompt failed: ${JSON.stringify(prompt.error)}`);
    for (let next = session.first; !next.done; next = await iterator.next()) {
      const event = recordFrom(next.value);
      const properties = recordFrom(event?.properties);
      if (properties?.sessionID !== sessionId) continue;
      if (event?.type === "message.updated") {
        const info = recordFrom(properties.info);
        if (typeof info?.id === "string" && typeof info.role === "string") roles.set(info.id, info.role);
      }
      if (event?.type === "message.part.updated") {
        const part = recordFrom(properties.part);
        if (part?.type === "text" && typeof part.id === "string" && typeof part.messageID === "string" && roles.get(part.messageID) === "assistant" && typeof part.text === "string") {
          const prior = emitted.get(part.id) ?? "";
          const delta = part.text.startsWith(prior) ? part.text.slice(prior.length) : part.text;
          if (delta) onDelta(delta);
          emitted.set(part.id, part.text);
        }
      }
      if (event?.type === "message.part.delta" && typeof properties.messageID === "string" && roles.get(properties.messageID) === "assistant" && properties.field === "text" && typeof properties.delta === "string") {
        onDelta(properties.delta);
        if (typeof properties.partID === "string") emitted.set(properties.partID, `${emitted.get(properties.partID) ?? ""}${properties.delta}`);
      }
      if (event?.type === "session.error") throw new Error(`OpenCode session failed: ${JSON.stringify(properties.error)}`);
      if (event?.type === "session.idle") {
        idle = true;
        break;
      }
    }
    // The stream also ends cleanly on abort and when the server goes away.
    if (!idle) throw session.streamFailure("OpenCode event stream ended before the session went idle");
  },
};

function runOpenCode(input: AdapterRunInput): Promise<AdapterRunOutput> {
  return runSession(input, openCodePlan);
}

export const openCodeAdapter = defineAdapter({
  id: "opencode",
  name: "OpenCode",
  command: "opencode",
}, {
  async probe(): Promise<AdapterProbeResult> {
    let version: string;
    try {
      const result = await runCommand("opencode", ["--version"], { timeoutMs: PROBE_TIMEOUT_MS });
      if (result.code !== 0) throw new Error(result.output || `opencode --version exited with code ${result.code}`);
      version = result.firstLine;
    } catch (error) {
      return probeFailure(error);
    }
    try {
      const listed = await loadInventory(process.cwd());
      return {
        installed: true,
        authenticated: listed.models.length > 0,
        version,
        ...listed,
      };
    } catch (error) {
      // A server that did not start, a listing that stalled or a transport
      // error says nothing about sign-in; only a listing with no connected
      // provider does, and that is the length check above.
      return probeFailure(error, version);
    }
  },

  run: runOpenCode,
});
