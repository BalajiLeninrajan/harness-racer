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
    createClientMock.mockReturnValue({
      session: { create, promptAsync },
      event: { subscribe: vi.fn().mockResolvedValue({ stream: events([
        { type: "message.updated", properties: { sessionID: "session-1", info: { id: "message-1", role: "assistant" } } },
        { type: "message.part.updated", properties: { sessionID: "session-1", part: { id: "part-1", messageID: "message-1", type: "text", text: "hel" } } },
        { type: "message.part.updated", properties: { sessionID: "session-1", part: { id: "part-1", messageID: "message-1", type: "text", text: "hello" } } },
        { type: "session.idle", properties: { sessionID: "session-1" } },
      ]) }) },
    });
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
    }));
    expect(promptAsync).toHaveBeenCalledWith(expect.objectContaining({ tools: {}, parts: [{ type: "text", text: "Reply" }] }));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects malformed model ids after signalling readiness", async () => {
    createClientMock.mockReturnValue({});
    const onReady = vi.fn();
    await expect(openCodeAdapter.run({
      cwd: "/tmp", model: "sonnet", prompt: "x", signal: new AbortController().signal,
      onReady, waitForStart: async () => {}, onDelta: vi.fn(),
    })).rejects.toThrow("Invalid OpenCode model id: sonnet");
    expect(onReady).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
