import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, processes } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  processes: [] as FakeProcess[],
}));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

class FakeStream extends EventEmitter {
  setEncoding() {}
}

class FakeProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  requests: Array<Record<string, unknown>> = [];
  stdin = {
    write: (line: string) => {
      const request = JSON.parse(line) as Record<string, unknown>;
      this.requests.push(request);
      if (typeof request.id !== "number") return true;
      let result: unknown = {};
      if (request.method === "session/new") {
        result = {
          sessionId: "session-1",
          models: {
            currentModelId: "grok-fast",
            availableModels: [
              { modelId: "grok-fast", name: "Grok Fast" },
              { modelId: "grok-build", name: "Grok Build" },
            ],
          },
        };
      }
      if (request.method === "session/prompt") {
        queueMicrotask(() => {
          this.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } } })}\n`);
        });
        result = { usage: { output_tokens: 7 } };
      }
      queueMicrotask(() => this.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`));
      return true;
    },
  };
  kill = vi.fn((signal: NodeJS.Signals) => {
    this.signalCode = signal;
    return true;
  });
}

import { grokAdapter } from "../src/server/adapters/grok.js";

describe("Grok adapter", () => {
  beforeEach(() => {
    processes.length = 0;
    spawnMock.mockReset();
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const child = new FakeProcess();
      processes.push(child);
      if (args[0] === "--version") queueMicrotask(() => {
        child.stdout.emit("data", "grok 1.2.3\n");
        child.exitCode = 0;
        child.emit("close", 0, null);
      });
      return child;
    });
  });

  it("probes ACP models and marks the active model as default", async () => {
    const result = await grokAdapter.probe();

    expect(result).toMatchObject({
      installed: true,
      authenticated: true,
      version: "grok 1.2.3",
      defaultModel: "grok-fast",
      models: [
        { id: "grok-fast", label: "Grok Fast", isDefault: true },
        { id: "grok-build", label: "Grok Build" },
      ],
    });
    expect(spawnMock).toHaveBeenCalledWith("grok", ["agent", "stdio"], expect.objectContaining({ shell: false }));
  });

  it("streams ACP text, switches models, and reports native token usage", async () => {
    const deltas: string[] = [];
    const onReady = vi.fn();
    const result = await grokAdapter.run({
      cwd: "/tmp/project",
      model: "grok-build",
      prompt: "Reply",
      signal: new AbortController().signal,
      onReady,
      waitForStart: async () => {},
      onDelta: (text) => deltas.push(text),
    });

    expect(onReady).toHaveBeenCalledOnce();
    expect(deltas).toEqual(["hello"]);
    expect(result).toEqual({ nativeOutputTokens: 7 });
    expect(processes[0]?.requests.map((request) => request.method)).toEqual([
      "initialize", "authenticate", "session/new", "session/set_model", "session/prompt",
    ]);
    expect(processes[0]?.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects an already-aborted run without spawning", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(grokAdapter.run({
      cwd: "/tmp", model: "grok-fast", prompt: "x", signal: controller.signal,
      onReady: vi.fn(), waitForStart: async () => {}, onDelta: vi.fn(),
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
