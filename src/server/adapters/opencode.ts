import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";

import type { ModelOption } from "../../shared/types.js";
import { defineAdapter, type AdapterProbeResult, type AdapterRunInput, type AdapterRunOutput } from "./types.js";

interface OpenCodeProcess {
  child: ChildProcess;
  url: string;
  terminate: () => void;
}

function abortError(): Error {
  const error = new Error("Benchmark cancelled");
  error.name = "AbortError";
  return error;
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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

async function startOpenCode(cwd: string): Promise<OpenCodeProcess> {
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
  const terminate = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
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
  return { child, url, terminate };
}

function parseModelId(value: string): { providerID: string; modelID: string } {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) throw new Error(`Invalid OpenCode model id: ${value}`);
  return { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) };
}

async function loadInventory(cwd: string): Promise<{ models: ModelOption[]; defaultModel?: string }> {
  const server = await startOpenCode(cwd);
  try {
    const client = createOpencodeClient({ baseUrl: server.url, directory: cwd });
    const response = await client.provider.list({ directory: cwd });
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
    const defaultModel = defaultEntry ? `${defaultEntry[0]}/${defaultEntry[1]}` : models[0]?.id;
    return {
      models: models.map((model) => ({ ...model, ...(model.id === defaultModel ? { isDefault: true } : {}) })),
      defaultModel,
    };
  } finally {
    server.terminate();
  }
}

async function runOpenCode(input: AdapterRunInput): Promise<AdapterRunOutput> {
  if (input.signal.aborted) throw abortError();
  let server: OpenCodeProcess | undefined;
  let ready = false;
  const signalReady = () => {
    if (!ready) {
      ready = true;
      input.onReady();
    }
  };
  try {
    server = await startOpenCode(input.cwd);
    const client = createOpencodeClient({ baseUrl: server.url, directory: input.cwd });
    const model = parseModelId(input.model);
    const created = await client.session.create({
      directory: input.cwd,
      title: "TPS Racer benchmark",
      model: { id: model.modelID, providerID: model.providerID },
      permission: [{ permission: "*", pattern: "*", action: "deny" }],
    });
    if (!created.data) throw new Error(`OpenCode session creation failed: ${JSON.stringify(created.error)}`);
    const sessionId = created.data.id;
    const controller = new AbortController();
    const subscription = await client.event.subscribe({ directory: input.cwd }, { signal: controller.signal });
    const onAbort = () => {
      controller.abort();
      server?.terminate();
    };
    input.signal.addEventListener("abort", onAbort, { once: true });
    signalReady();
    await input.waitForStart();
    if (input.signal.aborted) throw abortError();
    const roles = new Map<string, string>();
    const emitted = new Map<string, string>();
    try {
      const prompt = await client.session.promptAsync({
        sessionID: sessionId,
        directory: input.cwd,
        model,
        tools: {},
        parts: [{ type: "text", text: input.prompt }],
      });
      if (prompt.error) throw new Error(`OpenCode prompt failed: ${JSON.stringify(prompt.error)}`);
      for await (const rawEvent of subscription.stream) {
        const event = recordFrom(rawEvent);
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
            if (delta) input.onDelta(delta);
            emitted.set(part.id, part.text);
          }
        }
        if (event?.type === "message.part.delta" && typeof properties.messageID === "string" && roles.get(properties.messageID) === "assistant" && properties.field === "text" && typeof properties.delta === "string") {
          input.onDelta(properties.delta);
          if (typeof properties.partID === "string") emitted.set(properties.partID, `${emitted.get(properties.partID) ?? ""}${properties.delta}`);
        }
        if (event?.type === "session.error") throw new Error(`OpenCode session failed: ${JSON.stringify(properties.error)}`);
        if (event?.type === "session.idle") break;
      }
      return {};
    } finally {
      input.signal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  } catch (error) {
    signalReady();
    if (input.signal.aborted) throw abortError();
    throw error;
  } finally {
    server?.terminate();
  }
}

export const openCodeAdapter = defineAdapter({
  id: "opencode",
  name: "OpenCode",
  command: "opencode",
}, {
  async probe(): Promise<AdapterProbeResult> {
    let version = "";
    try {
      const child = spawn("opencode", ["--version"], { env: process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { output += chunk; });
      child.stderr.on("data", (chunk: string) => { output += chunk; });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      if (code !== 0) throw new Error(output.trim() || `OpenCode exited with code ${code}`);
      version = output.trim().split(/\r?\n/)[0] ?? "";
    } catch (error) {
      return {
        installed: false,
        authenticated: null,
        models: [],
        message: error instanceof Error ? error.message : String(error),
      };
    }
    try {
      const inventory = await loadInventory(process.cwd());
      return {
        installed: true,
        authenticated: inventory.models.length > 0,
        version,
        models: inventory.models,
        defaultModel: inventory.defaultModel,
      };
    } catch (error) {
      return {
        installed: true,
        authenticated: false,
        version,
        models: [],
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },

  run: runOpenCode,
});
