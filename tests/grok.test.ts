import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, processes, behaviour } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  processes: [] as FakeProcess[],
  // Requests the fake agent leaves unanswered or answers with an error.
  behaviour: { hang: [] as string[], fail: [] as string[] },
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
  stdin = Object.assign(new EventEmitter(), {
    write: (line: string) => {
      const request = JSON.parse(line) as Record<string, unknown>;
      this.requests.push(request);
      if (typeof request.id !== "number") return true;
      if (behaviour.hang.includes(String(request.method))) return true;
      if (behaviour.fail.includes(String(request.method))) {
        queueMicrotask(() => this.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { message: "not signed in" } })}\n`));
        return true;
      }
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
  });
  kill = vi.fn((signal: NodeJS.Signals) => {
    this.signalCode = signal;
    return true;
  });
}

import { grokAdapter } from "../src/server/adapters/grok.js";

describe("Grok adapter", () => {
  beforeEach(() => {
    processes.length = 0;
    behaviour.hang = [];
    behaviour.fail = [];
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

  it("terminates the agent and rejects when cancelled during the handshake", async () => {
    behaviour.hang = ["authenticate"];
    const controller = new AbortController();
    const run = grokAdapter.run({
      cwd: "/tmp/project", model: "grok-fast", prompt: "x", signal: controller.signal,
      onReady: vi.fn(), waitForStart: async () => {}, onDelta: vi.fn(),
    });
    await vi.waitFor(() => expect(processes[0]?.requests.at(-1)?.method).toBe("authenticate"));
    controller.abort(new Error("Benchmark cancelled."));

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(processes[0]?.kill).toHaveBeenCalledWith("SIGTERM");
    expect(processes[0]?.requests.some((request) => request.method === "session/cancel")).toBe(false);
  });

  it("reports signed out when the agent rejects authenticate", async () => {
    behaviour.fail = ["authenticate"];

    const result = await grokAdapter.probe();

    expect(result).toMatchObject({ installed: true, authenticated: false, models: [], message: expect.stringContaining("not signed in") });
    expect(processes[1]?.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("leaves sign-in state unknown when the agent rejects initialize", async () => {
    behaviour.fail = ["initialize"];

    const result = await grokAdapter.probe();

    // A refused handshake is not proof of a signed-out CLI, and false would
    // hide Grok in both UIs; null keeps it listed with the message.
    expect(result).toMatchObject({ installed: true, authenticated: null, message: expect.stringContaining("initialize failed") });
    expect(processes[1]?.requests.some((request) => request.method === "authenticate")).toBe(false);
    expect(processes[1]?.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("leaves sign-in state unknown when the agent exits during the probe handshake", async () => {
    behaviour.hang = ["authenticate"];
    const probe = grokAdapter.probe();
    await vi.waitFor(() => expect(processes[1]?.requests.at(-1)?.method).toBe("authenticate"));
    processes[1].stderr.emit("data", "segfault\n");
    processes[1].exitCode = 139;
    processes[1].emit("close", 139, null);

    const result = await probe;

    expect(result).toMatchObject({ installed: true, authenticated: null, message: expect.stringContaining("code 139: segfault") });
  });

  it("fails pending requests when stdin errors instead of crashing", async () => {
    behaviour.hang = ["authenticate"];
    const run = grokAdapter.run({
      cwd: "/tmp/project", model: "grok-fast", prompt: "x", signal: new AbortController().signal,
      onReady: vi.fn(), waitForStart: async () => {}, onDelta: vi.fn(),
    });
    await vi.waitFor(() => expect(processes[0]?.requests.at(-1)?.method).toBe("authenticate"));
    processes[0].stdin.emit("error", new Error("write EPIPE"));

    await expect(run).rejects.toThrow("write EPIPE");
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
