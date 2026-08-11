import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  query: vi.fn(),
  // A stand-in for the installed executable's recognized-model table, including the dated,
  // provider-suffixed, and explicit-zero-minor forms that alias a canonical id and must not
  // become separate entries.
  executable: Buffer.from([
    "\0claude-opus-4-6-fast\0claude-sonnet-5\0claude-opus-4-8\0",
    "claude-haiku-4-5-20251001-v1\0claude-opus-4-20250514\0claude-opus-4-0\0claude-opus-4\0claude-opus-5\0claude-fable-5\0claude-opus-5\0",
  ].join(""), "latin1"),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: mocks.query }));
vi.mock("node:fs", () => ({
  constants: { X_OK: 1 },
  accessSync: (file: string) => {
    if (file !== "/fake/bin/claude") throw new Error(`ENOENT: ${file}`);
  },
  realpathSync: (file: string) => file,
  statSync: () => ({ size: mocks.executable.length, mtimeMs: 1 }),
  openSync: () => 7,
  readSync: (_handle: number, buffer: Buffer, offset: number, length: number, position: number) =>
    mocks.executable.copy(buffer, offset, position, Math.min(position + length, mocks.executable.length)),
  closeSync: () => undefined,
}));

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

  it("probes version, authentication, and the models the installed executable recognizes", async () => {
    vi.stubEnv("PATH", "/fake/bin");
    mocks.spawn
      .mockImplementationOnce(() => commandProcess("2.1.0\n"))
      .mockImplementationOnce(() => commandProcess('{"loggedIn":true}\n'));
    const { claudeAdapter } = await import("../src/server/adapters/claude.js");

    const result = await claudeAdapter.probe();

    expect(mocks.spawn).toHaveBeenNthCalledWith(1, "claude", ["--version"], expect.any(Object));
    expect(mocks.spawn).toHaveBeenNthCalledWith(2, "claude", ["auth", "status", "--json"], expect.any(Object));
    expect(result).toMatchObject({ installed: true, authenticated: true, version: "2.1.0", defaultModel: "claude-opus-5" });
    expect(result.models).toEqual([
      { id: "claude-opus-5", label: "Claude Opus 5", isDefault: true },
      { id: "claude-fable-5", label: "Claude Fable 5" },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
      { id: "claude-opus-4-6-fast", label: "Claude Opus 4.6 Fast" },
      { id: "claude-opus-4", label: "Claude Opus 4" },
    ]);
    expect(result.message).toBeUndefined();
  });

  it("reports an empty catalog when the claude executable is not on PATH", async () => {
    vi.stubEnv("PATH", "/nowhere");
    mocks.spawn
      .mockImplementationOnce(() => commandProcess("2.1.0\n"))
      .mockImplementationOnce(() => commandProcess('{"loggedIn":true}\n'));
    const { claudeAdapter } = await import("../src/server/adapters/claude.js");

    const result = await claudeAdapter.probe();

    expect(result.models).toEqual([]);
    expect(result.defaultModel).toBeUndefined();
    expect(result.message).toMatch(/could not resolve the claude executable/i);
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
