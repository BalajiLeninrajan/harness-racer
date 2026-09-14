import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

type FakeChild = EventEmitter & {
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn> };
  stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
};

function commandProcess(stdout: string, stderr = "", code = 0) {
  const child = new EventEmitter() as FakeChild;
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn() });
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

// A spawn for a binary that is not on PATH.
function missingProcess(command: string) {
  const child = new EventEmitter() as FakeChild;
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn() });
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  queueMicrotask(() => child.emit("error", Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" })));
  return child;
}

// Requests named in `hang` are left unanswered.
function acpProcess(responses: Record<string, unknown>, hang: string[] = []) {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => { child.signalCode = "SIGTERM"; return true; });
  child.stdin = Object.assign(new EventEmitter(), { write: vi.fn((line: string) => {
    const request = JSON.parse(line) as { id?: number; method: string; params?: unknown };
    if (request.id === undefined || hang.includes(request.method)) return true;
    const result = responses[request.method];
    queueMicrotask(() => child.stdout.emit("data", `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`));
    return true;
  }) });
  return child;
}

describe("Cursor adapter", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.spawn.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("falls back from agent to cursor-agent when resolving the installed command", async () => {
    mocks.spawn
      .mockImplementationOnce(() => commandProcess("", "missing", 1))
      .mockImplementationOnce(() => commandProcess("cursor-agent 1.2\n"))
      .mockImplementationOnce(() => commandProcess('{"authenticated":false}\n'));
    const { cursorAdapter } = await import("../src/server/adapters/cursor.js");

    const result = await cursorAdapter.probe();

    expect(mocks.spawn.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ["agent", ["--version"]],
      ["cursor-agent", ["--version"]],
      ["cursor-agent", ["status", "--format", "json"]],
    ]);
    // Signed out, so no model list: nothing is invented to stand in for one.
    expect(result).toMatchObject({ installed: true, authenticated: false, version: "cursor-agent 1.2", models: [] });
    expect(result.defaultModel).toBeUndefined();
  });

  it("reports the --version failure itself when the binary is present but cursor-agent is not", async () => {
    mocks.spawn
      .mockImplementationOnce(() => commandProcess("", "agent: license check failed", 2))
      .mockImplementationOnce(() => missingProcess("cursor-agent"));
    const { cursorAdapter } = await import("../src/server/adapters/cursor.js");

    const result = await cursorAdapter.probe();

    // The binary is there, so "not installed" would contradict the flag; the
    // message is the reason --version gave.
    expect(result).toMatchObject({ installed: true, authenticated: null, models: [], message: "agent --version exited with code 2: agent: license check failed" });
  });

  it("reports the whole --version output when it fails, not just its first line", async () => {
    mocks.spawn
      .mockImplementationOnce(() => commandProcess("agent banner\n", "node:internal/modules/cjs/loader:1228\n  throw err;\n\nError: Cannot find module 'left-pad'\n", 1))
      .mockImplementationOnce(() => missingProcess("cursor-agent"));
    const { cursorAdapter } = await import("../src/server/adapters/cursor.js");

    const result = await cursorAdapter.probe();

    expect(result.message).toBe("agent --version exited with code 1: node:internal/modules/cjs/loader:1228\n  throw err;\n\nError: Cannot find module 'left-pad'\nagent banner");
  });

  it("reports not installed only when every candidate is missing from PATH", async () => {
    mocks.spawn.mockImplementation((command: string) => missingProcess(command));
    const { cursorAdapter } = await import("../src/server/adapters/cursor.js");

    const result = await cursorAdapter.probe();

    expect(result).toMatchObject({ installed: false, authenticated: null, models: [], message: "Cursor Agent is not installed or is not available on PATH" });
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it("probes the model list over ACP and marks the session's current model as default", async () => {
    mocks.spawn
      .mockImplementationOnce(() => commandProcess("1.2\n"))
      .mockImplementationOnce(() => commandProcess('{"loggedIn":true}\n'))
      .mockImplementationOnce(() => acpProcess({
        initialize: {}, authenticate: {},
        "session/new": { sessionId: "probe-1", configOptions: [{ id: "model-picker", category: "model", currentValue: "gpt-5" }] },
        "cursor/list_available_models": { models: [{ id: "auto", name: "Auto" }, { id: "gpt-5", name: "GPT-5" }, { id: "gpt-5", name: "GPT-5 again" }, { id: "sonnet", name: "Sonnet" }] },
      }));
    const { cursorAdapter } = await import("../src/server/adapters/cursor.js");

    const result = await cursorAdapter.probe();

    expect(result).toMatchObject({ installed: true, authenticated: true, defaultModel: "gpt-5" });
    expect(result.models).toEqual([{ id: "gpt-5", label: "GPT-5", isDefault: true }, { id: "sonnet", label: "Sonnet" }]);
  });

  it("gives up on a model discovery that stalls and reports it in the message", async () => {
    vi.useFakeTimers();
    let acp!: FakeChild;
    mocks.spawn
      .mockImplementationOnce(() => commandProcess("1.2\n"))
      .mockImplementationOnce(() => commandProcess('{"loggedIn":true}\n'))
      .mockImplementationOnce(() => (acp = acpProcess({ initialize: {} }, ["authenticate"])));
    const { cursorAdapter } = await import("../src/server/adapters/cursor.js");

    const probe = cursorAdapter.probe();
    // waitFor moves the fake clock a little on each check, so the bound is
    // approached in two steps rather than to the exact millisecond.
    await vi.waitFor(() => expect(acp.stdin.write).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(19_000);
    expect(acp.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);

    const result = await probe;
    expect(result).toMatchObject({ installed: true, authenticated: true, models: [], message: "Cursor ACP model discovery did not finish within 20s" });
    expect(acp.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("carries what the agent wrote to stderr in the discovery timeout message", async () => {
    vi.useFakeTimers();
    let acp!: FakeChild;
    mocks.spawn
      .mockImplementationOnce(() => commandProcess("1.2\n"))
      .mockImplementationOnce(() => commandProcess('{"loggedIn":true}\n'))
      .mockImplementationOnce(() => (acp = acpProcess({ initialize: {} }, ["authenticate"])));
    const { cursorAdapter } = await import("../src/server/adapters/cursor.js");

    const probe = cursorAdapter.probe();
    await vi.waitFor(() => expect(acp.stdin.write).toHaveBeenCalledTimes(2));
    // The stall's only explanation is on stderr; a bare timeout would hide it.
    acp.stderr.emit("data", "\u001b[33mOpen https://cursor.com/login to sign in\u001b[0m\n");
    await vi.advanceTimersByTimeAsync(20_000);

    const result = await probe;
    expect(result.message).toBe("Cursor ACP model discovery did not finish within 20s: Open https://cursor.com/login to sign in");
  });

  it("reports a status command that never exits instead of hanging the probe", async () => {
    vi.useFakeTimers();
    const stuck = acpProcess({});
    mocks.spawn
      .mockImplementationOnce(() => commandProcess("1.2\n"))
      .mockImplementationOnce(() => stuck);
    const { cursorAdapter } = await import("../src/server/adapters/cursor.js");

    const probe = cursorAdapter.probe();
    await vi.advanceTimersByTimeAsync(20_000);

    const result = await probe;
    expect(result).toMatchObject({ installed: true, authenticated: null, version: "1.2", models: [], message: "agent status --format json did not finish within 20s" });
    expect(stuck.kill).toHaveBeenCalledWith("SIGKILL");
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

  it("fails pending requests when stdin errors instead of crashing", async () => {
    let acp!: FakeChild;
    mocks.spawn
      .mockImplementationOnce(() => commandProcess("1.2\n"))
      .mockImplementationOnce(() => (acp = acpProcess({ initialize: {} }, ["authenticate"])));
    const { cursorAdapter } = await import("../src/server/adapters/cursor.js");

    const run = cursorAdapter.run({
      model: "gpt-5", prompt: "test", cwd: "/tmp/project", signal: new AbortController().signal,
      onReady: vi.fn(), waitForStart: vi.fn(), onDelta: vi.fn(),
    });
    await vi.waitFor(() => expect(acp.stdin.write).toHaveBeenCalledTimes(2));
    acp.stdin.emit("error", new Error("write EPIPE"));

    await expect(run).rejects.toThrow("write EPIPE");
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
    // A lane that fails in setup was never ready; the engine releases the
    // start barrier on the rejection itself.
    expect(onReady).not.toHaveBeenCalled();
  });
});
