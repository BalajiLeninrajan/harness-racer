import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { codexTurnStartParams } from "../src/server/adapters/codex.js";

const processMocks = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: processMocks.execFile, spawn: processMocks.spawn }));

type Request = { id?: number; method: string; params?: Record<string, unknown> };

function fakeAppServer(
  respond: (request: Request, server: ReturnType<typeof fakeAppServer>) => unknown,
) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal: NodeJS.Signals) => {
    child.signalCode = signal;
    return true;
  });
  const requests: Request[] = [];
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const request = JSON.parse(line) as Request;
      requests.push(request);
      if (request.id === undefined) continue;
      try {
        const result = respond(request, server);
        if (result instanceof Error) server.send({ id: request.id, error: { message: result.message } });
        else server.send({ id: request.id, result });
      } catch (error) {
        server.send({ id: request.id, error: { message: error instanceof Error ? error.message : String(error) } });
      }
    }
  });
  const server = {
    child,
    requests,
    send(message: unknown) { child.stdout.write(`${JSON.stringify(message)}\n`); },
  };
  return server;
}

function useAppServer(server: ReturnType<typeof fakeAppServer>): void {
  processMocks.spawn.mockImplementation(() => {
    queueMicrotask(() => server.child.emit("spawn"));
    return server.child;
  });
}

describe("Codex adapter protocol", () => {
  beforeEach(() => {
    processMocks.execFile.mockReset();
    processMocks.spawn.mockReset();
  });

  it("uses the current app-server text input shape and explicit benchmark permissions", () => {
    expect(codexTurnStartParams("thread-1", "gpt-5.5", "Reply with the payload.")).toEqual({
      threadId: "thread-1",
      model: "gpt-5.5",
      effort: "medium",
      input: [{
        type: "text",
        text: "Reply with the payload.",
        text_elements: [],
      }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
  });

  it("can pin the model-advertised reasoning effort instead of inheriting local config", () => {
    expect(codexTurnStartParams("thread-1", "gpt-5.6-sol", "Reply.", "low")).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "low",
    });
  });

  it("probes version, authentication, and paginated visible models", async () => {
    processMocks.execFile.mockImplementation((_command, _args, _options, callback) => callback(null, "codex-cli 1.8.0\n"));
    const server = fakeAppServer((request) => {
      if (request.method === "initialize") return { userAgent: "codex-test" };
      if (request.method === "account/read") return { account: { email: "tester@example.com" } };
      if (request.method === "model/list" && !request.params?.cursor) return {
        data: [
          { model: "gpt-5", displayName: "GPT-5", isDefault: true, defaultReasoningEffort: "low" },
          { model: "hidden", displayName: "Hidden", hidden: true, isDefault: false },
        ],
        nextCursor: "page-2",
      };
      if (request.method === "model/list") return {
        data: [{ model: "gpt-5-mini", displayName: "GPT-5 Mini", isDefault: false }],
      };
      throw new Error(`Unexpected ${request.method}`);
    });
    useAppServer(server);
    const { codexAdapter } = await import("../src/server/adapters/codex.js");

    await expect(codexAdapter.probe()).resolves.toMatchObject({
      installed: true,
      authenticated: true,
      version: "1.8.0",
      defaultModel: "gpt-5",
      models: [
        { id: "gpt-5", label: "GPT-5", isDefault: true },
        { id: "gpt-5-mini", label: "GPT-5 Mini" },
      ],
    });
    expect(server.requests.filter(({ method }) => method === "model/list").map(({ params }) => params)).toEqual([{}, { cursor: "page-2" }]);
    expect(server.child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("runs the app-server lifecycle, filters unrelated deltas, and returns native token usage", async () => {
    const server = fakeAppServer((request, rpc) => {
      if (request.method === "initialize") return {};
      if (request.method === "thread/start") return { thread: { id: "thread-1" } };
      if (request.method === "turn/start") {
        queueMicrotask(() => {
          rpc.send({ method: "item/agentMessage/delta", params: { threadId: "other", turnId: "turn-1", delta: "ignored" } });
          rpc.send({ method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", delta: "hello" } });
          rpc.send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-1", turnId: "turn-1", tokenUsage: { last: { outputTokens: 9 } } } });
          rpc.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } });
        });
        return { turn: { id: "turn-1" } };
      }
      throw new Error(`Unexpected ${request.method}`);
    });
    useAppServer(server);
    const { codexAdapter } = await import("../src/server/adapters/codex.js");
    const input = {
      model: "gpt-5", prompt: "Say hello", cwd: "/tmp/project", signal: new AbortController().signal,
      onReady: vi.fn(), waitForStart: vi.fn().mockResolvedValue(undefined), onDelta: vi.fn(),
    };

    await expect(codexAdapter.run(input)).resolves.toEqual({ nativeOutputTokens: 9 });
    expect(input.onReady).toHaveBeenCalledOnce();
    expect(input.onDelta).toHaveBeenCalledExactlyOnceWith("hello");
    expect(server.requests.map(({ method }) => method)).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    expect(server.requests.find(({ method }) => method === "turn/start")?.params).toMatchObject({
      threadId: "thread-1", model: "gpt-5", effort: "low", approvalPolicy: "never",
    });
    expect(server.child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("surfaces a non-retryable turn error and still closes the app-server", async () => {
    const server = fakeAppServer((request, rpc) => {
      if (request.method === "initialize") return {};
      if (request.method === "thread/start") return { thread: { id: "thread-1" } };
      if (request.method === "turn/start") {
        queueMicrotask(() => rpc.send({ method: "error", params: { threadId: "thread-1", willRetry: false, error: { message: "quota exhausted" } } }));
        return { turn: { id: "turn-1" } };
      }
      throw new Error(`Unexpected ${request.method}`);
    });
    useAppServer(server);
    const { codexAdapter } = await import("../src/server/adapters/codex.js");

    await expect(codexAdapter.run({
      model: "gpt-5", prompt: "test", cwd: "/tmp/project", signal: new AbortController().signal,
      onReady: vi.fn(), waitForStart: vi.fn().mockResolvedValue(undefined), onDelta: vi.fn(),
    })).rejects.toThrow("quota exhausted");
    expect(server.child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("interrupts an active turn when cancelled and closes the app-server", async () => {
    const controller = new AbortController();
    const server = fakeAppServer((request) => {
      if (request.method === "initialize") return {};
      if (request.method === "thread/start") return { thread: { id: "thread-1" } };
      if (request.method === "turn/start") {
        queueMicrotask(() => controller.abort());
        return { turn: { id: "turn-1" } };
      }
      if (request.method === "turn/interrupt") return {};
      throw new Error(`Unexpected ${request.method}`);
    });
    useAppServer(server);
    const { codexAdapter } = await import("../src/server/adapters/codex.js");

    await expect(codexAdapter.run({
      model: "gpt-5", prompt: "test", cwd: "/tmp/project", signal: controller.signal,
      onReady: vi.fn(), waitForStart: vi.fn().mockResolvedValue(undefined), onDelta: vi.fn(),
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(server.requests).toContainEqual(expect.objectContaining({
      method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" },
    }));
    expect(server.child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
