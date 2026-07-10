import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  query: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mocks.query }));

function commandProcess(stdout: string, stderr = "", code = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: (encoding: string) => void };
    stderr: EventEmitter & { setEncoding: (encoding: string) => void };
  };
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", stdout);
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("close", code);
  });
  return child;
}

function runInput(signal = new AbortController().signal) {
  return {
    model: "claude-sonnet-5",
    prompt: "Say hello",
    cwd: "/tmp/project",
    signal,
    onReady: vi.fn(),
    waitForStart: vi.fn().mockResolvedValue(undefined),
    onDelta: vi.fn(),
  };
}

describe("Claude adapter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("probes version, authentication, and the supported model catalog", async () => {
    mocks.spawn
      .mockImplementationOnce(() => commandProcess("2.1.0\n"))
      .mockImplementationOnce(() => commandProcess('{"loggedIn":true}\n'));
    const { claudeAdapter } = await import("../src/server/adapters/claude.js");

    const result = await claudeAdapter.probe();

    expect(mocks.spawn).toHaveBeenNthCalledWith(1, "claude", ["--version"], expect.any(Object));
    expect(mocks.spawn).toHaveBeenNthCalledWith(2, "claude", ["auth", "status", "--json"], expect.any(Object));
    expect(result).toMatchObject({ installed: true, authenticated: true, version: "2.1.0", defaultModel: "claude-sonnet-5" });
    expect(result.models).toContainEqual(expect.objectContaining({ id: "claude-sonnet-5", isDefault: true }));
  });

  it("streams SDK deltas and returns native output-token usage", async () => {
    const close = vi.fn();
    mocks.query.mockReturnValue(Object.assign((async function* () {
      yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } } };
      yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } };
      yield { type: "result", usage: { output_tokens: 7 } };
    })(), { close }));
    const { claudeAdapter } = await import("../src/server/adapters/claude.js");
    const input = runInput();

    await expect(claudeAdapter.run(input)).resolves.toEqual({ nativeOutputTokens: 7 });

    expect(input.onReady).toHaveBeenCalledOnce();
    expect(input.waitForStart).toHaveBeenCalledOnce();
    expect(input.onDelta.mock.calls.flat()).toEqual(["hel", "lo"]);
    expect(mocks.query).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Say hello",
      options: expect.objectContaining({ model: "claude-sonnet-5", permissionMode: "plan", allowedTools: [] }),
    }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects an already-cancelled run without invoking the SDK", async () => {
    const controller = new AbortController();
    controller.abort();
    const { claudeAdapter } = await import("../src/server/adapters/claude.js");

    await expect(claudeAdapter.run(runInput(controller.signal))).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
