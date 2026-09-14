import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, createServerMock, createClientMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  createServerMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("node:net", () => ({ createServer: createServerMock }));
vi.mock("@opencode-ai/sdk/v2", () => ({ createOpencodeClient: createClientMock }));

class FakeStream extends EventEmitter { setEncoding() {} }
class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => true);
}

import { openCodeAdapter } from "../src/server/adapters/opencode.js";

function events(values: unknown[]): AsyncIterable<unknown> {
  return { async *[Symbol.asyncIterator]() { yield* values; } };
}

describe("OpenCode adapter", () => {
  let child: FakeChild;
  beforeEach(() => {
    vi.restoreAllMocks();
    child = new FakeChild();
    spawnMock.mockReset().mockReturnValue(child);
    createServerMock.mockReset().mockReturnValue({
      once: vi.fn(),
      listen: (_port: number, _host: string, callback: () => void) => queueMicrotask(callback),
      address: () => ({ port: 43123 }),
      close: (callback: () => void) => callback(),
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    createClientMock.mockReset();
  });

  it("discovers only connected providers and selects their configured default", async () => {
    createClientMock.mockReturnValue({ provider: { list: vi.fn().mockResolvedValue({ data: {
      connected: ["anthropic"],
      all: [
        { id: "anthropic", models: { sonnet: { id: "sonnet", name: "Sonnet" } } },
        { id: "offline", models: { nope: { id: "nope", name: "Nope" } } },
      ],
      default: { anthropic: "sonnet" },
    } }) } });
    queueMicrotask(() => { child.stdout.emit("data", "opencode 2.0\n"); child.exitCode = 0; child.emit("close", 0); });

    const result = await openCodeAdapter.probe();

    expect(result).toMatchObject({
      installed: true, authenticated: true, version: "opencode 2.0",
      defaultModel: "anthropic/sonnet",
      models: [{ id: "anthropic/sonnet", label: "Sonnet", isDefault: true }],
    });
  });

  it("creates a denied-permission session and emits assistant text deltas", async () => {
    const promptAsync = vi.fn().mockResolvedValue({});
    const create = vi.fn().mockResolvedValue({ data: { id: "session-1" } });
    const subscribe = vi.fn().mockResolvedValue({ stream: events([
      { type: "message.updated", properties: { sessionID: "session-1", info: { id: "message-1", role: "assistant" } } },
      { type: "message.part.updated", properties: { sessionID: "session-1", part: { id: "part-1", messageID: "message-1", type: "text", text: "hel" } } },
      { type: "message.part.updated", properties: { sessionID: "session-1", part: { id: "part-1", messageID: "message-1", type: "text", text: "hello" } } },
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ]) });
    createClientMock.mockReturnValue({ session: { create, promptAsync }, event: { subscribe } });
    const deltas: string[] = [];
    const onReady = vi.fn();

    await expect(openCodeAdapter.run({
      cwd: "/tmp/project", model: "anthropic/sonnet", prompt: "Reply",
      signal: new AbortController().signal, onReady, waitForStart: async () => {},
      onDelta: (text) => deltas.push(text),
    })).resolves.toEqual({});

    expect(onReady).toHaveBeenCalledOnce();
    expect(deltas).toEqual(["hel", "lo"]);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      model: { providerID: "anthropic", id: "sonnet" },
      permission: [{ permission: "*", pattern: "*", action: "deny" }],
    }), { signal: expect.any(AbortSignal) });
    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({ tools: {}, parts: [{ type: "text", text: "Reply" }] }),
      { signal: expect.any(AbortSignal) },
    );
    expect(subscribe).toHaveBeenCalledWith(
      { directory: "/tmp/project" },
      { signal: expect.any(AbortSignal), sseMaxRetryAttempts: 1, onSseError: expect.any(Function) },
    );
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("has the event stream open before the prompt is sent", async () => {
    // The SDK's stream is a lazy generator: nothing connects to /event until
    // it is pulled, and the server confirms a new subscriber with
    // server.connected. Any event the prompt produces before then is lost.
    let connect!: () => void;
    const connected = new Promise<void>((resolve) => { connect = resolve; });
    let firstEventDelivered = false;
    const stream = {
      async *[Symbol.asyncIterator]() {
        await connected;
        firstEventDelivered = true;
        yield { type: "server.connected", properties: {} };
        yield { type: "message.updated", properties: { sessionID: "session-1", info: { id: "message-1", role: "assistant" } } };
        yield { type: "message.part.delta", properties: { sessionID: "session-1", messageID: "message-1", partID: "part-1", field: "text", delta: "hello" } };
        yield { type: "session.idle", properties: { sessionID: "session-1" } };
      },
    };
    const promptAsync = vi.fn().mockResolvedValue({});
    let startedAfterFirstEvent: boolean | undefined;
    const waitForStart = vi.fn(async () => { startedAfterFirstEvent = firstEventDelivered; });
    const subscribe = vi.fn().mockResolvedValue({ stream });
    createClientMock.mockReturnValue({
      session: { create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }), promptAsync },
      event: { subscribe },
    });
    const deltas: string[] = [];

    const run = openCodeAdapter.run({
      cwd: "/tmp/project", model: "anthropic/sonnet", prompt: "Reply",
      signal: new AbortController().signal, onReady: vi.fn(), waitForStart, onDelta: (text) => deltas.push(text),
    });
    // The adapter polls the server for a while before it subscribes, so the
    // check only means something once it has.
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(waitForStart).not.toHaveBeenCalled();
    expect(promptAsync).not.toHaveBeenCalled();
    connect();

    await expect(run).resolves.toEqual({});
    expect(startedAfterFirstEvent).toBe(true);
    expect(promptAsync).toHaveBeenCalledOnce();
    expect(deltas).toEqual(["hello"]);
  });

  it("reports the stream error and the server's stderr when the stream ends early", async () => {
    // With no reconnects the SDK hands the failure to onSseError and ends the
    // stream as if it had closed cleanly.
    const subscribe = vi.fn(async (_parameters: unknown, options: { onSseError: (error: unknown) => void }) => ({
      stream: {
        async *[Symbol.asyncIterator]() {
          yield { type: "server.connected", properties: {} };
          child.stderr.emit("data", "panic: out of file descriptors\n");
          options.onSseError(new Error("SSE failed: 500 Internal Server Error"));
        },
      },
    }));
    createClientMock.mockReturnValue({
      session: { create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }), promptAsync: vi.fn().mockResolvedValue({}) },
      event: { subscribe },
    });

    await expect(openCodeAdapter.run({
      cwd: "/tmp/project", model: "anthropic/sonnet", prompt: "Reply",
      signal: new AbortController().signal, onReady: vi.fn(), waitForStart: async () => {}, onDelta: vi.fn(),
    })).rejects.toThrow(
      "OpenCode event stream ended before the session went idle (stream error: SSE failed: 500 Internal Server Error; server stderr: panic: out of file descriptors)",
    );
  });

  it("fails setup when the event stream cannot be opened", async () => {
    const subscribe = vi.fn(async (_parameters: unknown, options: { onSseError: (error: unknown) => void }) => ({
      stream: { async *[Symbol.asyncIterator]() { options.onSseError(new Error("fetch failed: ECONNREFUSED")); } },
    }));
    const promptAsync = vi.fn();
    createClientMock.mockReturnValue({
      session: { create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }), promptAsync },
      event: { subscribe },
    });

    await expect(openCodeAdapter.run({
      cwd: "/tmp/project", model: "anthropic/sonnet", prompt: "Reply",
      signal: new AbortController().signal, onReady: vi.fn(), waitForStart: async () => {}, onDelta: vi.fn(),
    })).rejects.toThrow("OpenCode event stream could not be opened (stream error: fetch failed: ECONNREFUSED)");
    expect(promptAsync).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("fails when the event stream ends before the session goes idle", async () => {
    createClientMock.mockReturnValue({
      session: { create: vi.fn().mockResolvedValue({ data: { id: "session-1" } }), promptAsync: vi.fn().mockResolvedValue({}) },
      event: { subscribe: vi.fn().mockResolvedValue({ stream: events([
        { type: "message.updated", properties: { sessionID: "session-1", info: { id: "message-1", role: "assistant" } } },
        { type: "message.part.updated", properties: { sessionID: "session-1", part: { id: "part-1", messageID: "message-1", type: "text", text: "hel" } } },
      ]) }) },
    });

    await expect(openCodeAdapter.run({
      cwd: "/tmp/project", model: "anthropic/sonnet", prompt: "Reply",
      signal: new AbortController().signal, onReady: vi.fn(), waitForStart: async () => {}, onDelta: vi.fn(),
    })).rejects.toThrow("before the session went idle");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("escalates to SIGKILL when the server ignores SIGTERM", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      createClientMock.mockReturnValue({});
      await expect(openCodeAdapter.run({
        cwd: "/tmp", model: "sonnet", prompt: "x", signal: new AbortController().signal,
        onReady: vi.fn(), waitForStart: async () => {}, onDelta: vi.fn(),
      })).rejects.toThrow("Invalid OpenCode model id");
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");

      vi.advanceTimersByTime(1_499);
      expect(child.kill).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send SIGKILL to a server that exited on SIGTERM", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      child.kill.mockImplementation(() => { child.exitCode = 0; return true; });
      createClientMock.mockReturnValue({});
      await expect(openCodeAdapter.run({
        cwd: "/tmp", model: "sonnet", prompt: "x", signal: new AbortController().signal,
        onReady: vi.fn(), waitForStart: async () => {}, onDelta: vi.fn(),
      })).rejects.toThrow("Invalid OpenCode model id");

      vi.advanceTimersByTime(2_000);
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the server when cancelled while the session is being created", async () => {
    const controller = new AbortController();
    const create = vi.fn((_parameters: unknown, options?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("The request was aborted.")), { once: true });
    }));
    createClientMock.mockReturnValue({ session: { create }, event: { subscribe: vi.fn() } });

    const run = openCodeAdapter.run({
      cwd: "/tmp/project", model: "anthropic/sonnet", prompt: "Reply", signal: controller.signal,
      onReady: vi.fn(), waitForStart: async () => {}, onDelta: vi.fn(),
    });
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    controller.abort(new Error("Benchmark cancelled."));

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects malformed model ids without signalling readiness", async () => {
    createClientMock.mockReturnValue({});
    const onReady = vi.fn();
    await expect(openCodeAdapter.run({
      cwd: "/tmp", model: "sonnet", prompt: "x", signal: new AbortController().signal,
      onReady, waitForStart: async () => {}, onDelta: vi.fn(),
    })).rejects.toThrow("Invalid OpenCode model id: sonnet");
    expect(onReady).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
