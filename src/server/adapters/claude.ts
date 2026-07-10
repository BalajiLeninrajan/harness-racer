import { spawn } from "node:child_process";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";

import type { ModelOption, ProviderInfo } from "../../shared/types.js";
import type { AdapterRunInput, AdapterRunOutput, HarnessAdapter } from "./types.js";

const CLAUDE_MODELS: ModelOption[] = [
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", isDefault: true },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

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

export const claudeAdapter: HarnessAdapter = {
  id: "claudeAgent",
  name: "Claude",
  command: "claude",

  async probe(): Promise<ProviderInfo> {
    let version: CommandResult;
    try {
      version = await runCommand(["--version"]);
    } catch (error) {
      return {
        id: "claudeAgent",
        name: "Claude",
        command: "claude",
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
    return {
      id: "claudeAgent",
      name: "Claude",
      command: "claude",
      installed: version.code === 0,
      authenticated,
      version: (version.stdout || version.stderr).trim().split(/\r?\n/)[0],
      models: CLAUDE_MODELS.map((model) => ({ ...model })),
      defaultModel: CLAUDE_MODELS[0].id,
    };
  },

  async listModels(): Promise<ModelOption[]> {
    return CLAUDE_MODELS.map((model) => ({ ...model }));
  },

  run: runClaude,
};
