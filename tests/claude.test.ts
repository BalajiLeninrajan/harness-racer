import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  startup: vi.fn(),
  // A stand-in for the installed executable's recognized-model table, including the dated,
  // provider-suffixed, and explicit-zero-minor forms that alias a canonical id and must not
  // become separate entries.
  executable: Buffer.from([
    "\0claude-opus-4-6-fast\0claude-sonnet-5\0claude-opus-4-8\0",
    "claude-haiku-4-5-20251001-v1\0claude-opus-4-20250514\0claude-opus-4-0\0claude-opus-4\0claude-opus-5\0claude-fable-5\0claude-opus-5\0",
  ].join(""), "latin1"),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ startup: mocks.startup }));
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

  // A stand-in for the SDK's WarmQuery: the CLI is "up" once startup resolves,
  // and query() hands back the message iterator for the one prompt.
  function warmQuery(messages: () => AsyncGenerator<unknown>, order: string[] = []) {
    const close = vi.fn();
    const warm = {
      query: vi.fn((prompt: string) => {
        order.push(`query:${prompt}`);
        return Object.assign(messages(), { close });
      }),
      close: vi.fn(),
    };
    return { warm, close };
  }

  it("is ready once the CLI has started, prompts at the start signal, and streams SDK deltas", async () => {
    const order: string[] = [];
    const { warm, close } = warmQuery(async function* () {
      yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } } };
      yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } };
      yield { type: "result", usage: { output_tokens: 7 } };
    }, order);
    mocks.startup.mockImplementation(async () => {
      order.push("startup");
      return warm;
    });
    const { claudeAdapter } = await import("../src/server/adapters/claude.js");
    const input = {
      ...runInput(),
      onReady: vi.fn(() => { order.push("ready"); }),
      waitForStart: vi.fn(async () => { order.push("start"); }),
    };

    await expect(claudeAdapter.run(input)).resolves.toEqual({ nativeOutputTokens: 7 });

    // The CLI's boot is harness prep, not part of the prompt's time to first output.
    expect(order).toEqual(["startup", "ready", "start", "query:Say hello"]);
    expect(input.onReady).toHaveBeenCalledOnce();
    expect(input.onDelta.mock.calls.flat()).toEqual(["hel", "lo"]);
    expect(mocks.startup).toHaveBeenCalledWith({
      options: expect.objectContaining({
        cwd: "/tmp/project",
        model: "claude-sonnet-5",
        permissionMode: "plan",
        allowedTools: [],
        abortController: expect.any(AbortController),
      }),
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not declare ready when the CLI fails to start", async () => {
    mocks.startup.mockRejectedValue(new Error("Subprocess initialization did not complete within 60000ms"));
    const { claudeAdapter } = await import("../src/server/adapters/claude.js");
    const input = runInput();

    await expect(claudeAdapter.run(input)).rejects.toThrow("Subprocess initialization did not complete");
    expect(input.onReady).not.toHaveBeenCalled();
    expect(input.waitForStart).not.toHaveBeenCalled();
  });

  it("rejects a run cancelled mid-stream even though the SDK ends the iterator cleanly", async () => {
    const controller = new AbortController();
    const { warm, close } = warmQuery(async function* () {
      yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } } };
      controller.abort(new Error("Benchmark cancelled."));
      // close() makes the CLI exit 0, and the SDK ends the iterator as if the turn had finished.
      yield { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } };
    });
    mocks.startup.mockResolvedValue(warm);
    const { claudeAdapter } = await import("../src/server/adapters/claude.js");
    const input = runInput(controller.signal);

    await expect(claudeAdapter.run(input)).rejects.toMatchObject({ name: "AbortError" });
    expect(input.onDelta.mock.calls.flat()).toEqual(["hel"]);
    expect(close).toHaveBeenCalled();
  });

  it("aborts the CLI when cancelled while it is still starting", async () => {
    const controller = new AbortController();
    let sdkAbort: AbortController | undefined;
    // Like the SDK: the handshake fails once the controller it was given aborts.
    mocks.startup.mockImplementation(({ options }: { options: { abortController: AbortController } }) => {
      sdkAbort = options.abortController;
      return new Promise((_resolve, reject) => {
        options.abortController.signal.addEventListener("abort", () => reject(new Error("Claude Code process aborted by user")), { once: true });
      });
    });
    const { claudeAdapter } = await import("../src/server/adapters/claude.js");
    const input = runInput(controller.signal);

    const run = claudeAdapter.run(input);
    await vi.waitFor(() => expect(sdkAbort).toBeDefined());
    controller.abort(new Error("Benchmark cancelled."));

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(sdkAbort?.signal.aborted).toBe(true);
    expect(input.onReady).not.toHaveBeenCalled();
  });

  it("rejects an already-cancelled run without invoking the SDK", async () => {
    const controller = new AbortController();
    controller.abort();
    const { claudeAdapter } = await import("../src/server/adapters/claude.js");

    await expect(claudeAdapter.run(runInput(controller.signal))).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.startup).not.toHaveBeenCalled();
  });
});
