import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

type FakeChild = EventEmitter & {
  stdin: { write: ReturnType<typeof vi.fn> };
  stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
};

function commandProcess(stdout: string, stderr = "", code = 0) {
  const child = new EventEmitter() as FakeChild;
  child.stdin = { write: vi.fn() };
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.exitCode = code;
  child.signalCode = null;
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", stdout);
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("close", code, null);
  });
  return child;
}

function acpProcess(responses: Record<string, unknown>) {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => { child.signalCode = "SIGTERM"; return true; });
  child.stdin = { write: vi.fn((line: string) => {
    const request = JSON.parse(line) as { id?: number; method: string; params?: unknown };
    if (request.id === undefined) return true;
    const result = responses[request.method];
    queueMicrotask(() => child.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`));
    return true;
  }) };
  return child;
}

describe("Cursor adapter", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.spawn.mockReset();
  });

  it("falls back from agent to cursor-agent when resolving the installed command", async () => {
    mocks.spawn
      .mockImplementationOnce(() => commandProcess("", "missing", 1))
      .mockImplementationOnce(() => commandProcess("cursor-agent 1.2\n"))
      .mockImplementationOnce(() => commandProcess("cursor-agent 1.2\n"))
      .mockImplementationOnce(() => commandProcess('{"authenticated":false}\n'));
    const { cursorAdapter } = await import("../src/server/adapters/cursor.js");

    const result = await cursorAdapter.probe();

    expect(mocks.spawn.mock.calls.slice(0, 2).map((call) => call.slice(0, 2))).toEqual([
      ["agent", ["--version"]],
      ["cursor-agent", ["--version"]],
    ]);
    expect(result).toMatchObject({ installed: true, authenticated: false, defaultModel: "default" });
    expect(result.models).toEqual([{ id: "default", label: "Cursor Auto (dynamic)" }]);
  });

  it("runs the ACP handshake, selects a concrete model, and streams matching session chunks", async () => {
    const responses = {
      initialize: {},
      authenticate: {},
      "session/new": {
        sessionId: "session-1",
        configOptions: [{ id: "model-picker", category: "model", options: [{ value: "gpt-5" }] }],
      },
      "session/set_config_option": {},
      "session/prompt": { usage: { outputTokens: 11 } },
    };
    let acp!: FakeChild;
    mocks.spawn
      .mockImplementationOnce(() => commandProcess("1.2\n"))
      .mockImplementationOnce(() => (acp = acpProcess(responses)));
    const { cursorAdapter } = await import("../src/server/adapters/cursor.js");
    const input = {
      model: "gpt-5",
      prompt: "Say hello",
      cwd: "/tmp/project",
      signal: new AbortController().signal,
      onReady: vi.fn(),
      waitForStart: vi.fn().mockImplementation(async () => {
        acp.stdout.emit("data", `${JSON.stringify({ method: "session/update", params: {
          sessionId: "session-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } },
        } })}\n`);
      }),
      onDelta: vi.fn(),
    };

    await expect(cursorAdapter.run(input)).resolves.toEqual({ nativeOutputTokens: 11 });
    expect(input.onReady).toHaveBeenCalledOnce();
    expect(input.onDelta).toHaveBeenCalledWith("hello");
    const requests = acp.stdin.write.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(requests.map((request) => request.method)).toEqual([
      "initialize", "authenticate", "session/new", "session/set_config_option", "session/set_config_option", "session/prompt",
    ]);
    expect(requests[3].params).toEqual({ sessionId: "session-1", configId: "model-picker", value: "gpt-5" });
    expect(requests[4].params).toEqual({ sessionId: "session-1", configId: "mode", value: "ask" });
    expect(acp.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects Cursor Auto before sending a benchmark prompt", async () => {
    mocks.spawn
      .mockImplementationOnce(() => commandProcess("1.2\n"))
      .mockImplementationOnce(() => acpProcess({
        initialize: {}, authenticate: {}, "session/new": { sessionId: "session-1" },
      }));
    const { cursorAdapter } = await import("../src/server/adapters/cursor.js");
    const onReady = vi.fn();

    await expect(cursorAdapter.run({
      model: "default", prompt: "test", cwd: "/tmp/project", signal: new AbortController().signal,
      onReady, waitForStart: vi.fn(), onDelta: vi.fn(),
    })).rejects.toThrow("Cursor Auto is dynamic");
    expect(onReady).toHaveBeenCalledOnce();
  });
});
