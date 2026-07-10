import { EventEmitter } from "node:events";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const provider = {
    id: "codex" as const,
    name: "Codex",
    command: "codex",
    installed: true,
    authenticated: true,
    models: [],
  };
  return {
    probe: vi.fn(async () => provider),
    runBenchmark: vi.fn(async () => undefined),
  };
});

vi.mock("../src/server/adapters/index.js", () => ({
  adapters: [{ id: "codex", probe: mocks.probe }],
}));

vi.mock("../src/server/benchmark.js", () => ({
  runBenchmark: mocks.runBenchmark,
}));

import { attachWebSockets, handleApi } from "../src/server/app.js";

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  readonly sent: unknown[] = [];

  send(payload: string): void {
    this.sent.push(JSON.parse(payload));
  }

  receive(payload: unknown): void {
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.emit("message", Buffer.from(raw));
  }
}

function fakeResponse() {
  const response = {
    status: undefined as number | undefined,
    headers: undefined as Record<string, string> | undefined,
    body: "",
    writeHead(status: number, headers: Record<string, string>) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    end(body = "") {
      this.body = body;
      return this;
    },
  };
  return response;
}

function validRequest() {
  return {
    type: "start",
    mode: "parallel",
    samplePreset: "quick",
    competitors: [
      { id: "one", harness: "codex", model: "gpt-5", label: "One", color: "#fff" },
      { id: "two", harness: "cursor", model: "gpt-5", label: "Two", color: "#000" },
    ],
  } as const;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("server app", () => {
  beforeEach(() => {
    mocks.probe.mockClear();
    mocks.runBenchmark.mockReset();
    mocks.runBenchmark.mockResolvedValue(undefined);
  });

  it("serves provider metadata only from the providers endpoint", async () => {
    const response = fakeResponse();
    const handled = await handleApi(
      { method: "GET", url: "/api/providers" } as IncomingMessage,
      response as unknown as ServerResponse,
    );

    expect(handled).toBe(true);
    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    expect(JSON.parse(response.body)).toEqual({
      providers: [expect.objectContaining({ id: "codex", installed: true })],
    });

    expect(
      await handleApi(
        { method: "POST", url: "/api/providers" } as IncomingMessage,
        fakeResponse() as unknown as ServerResponse,
      ),
    ).toBe(false);
    expect(
      await handleApi(
        { method: "GET", url: "/api/unknown" } as IncomingMessage,
        fakeResponse() as unknown as ServerResponse,
      ),
    ).toBe(false);
  });

  it("returns a JSON error when provider discovery fails", async () => {
    mocks.probe.mockRejectedValueOnce(new Error("probe failed"));
    const response = fakeResponse();

    expect(
      await handleApi(
        { method: "GET", url: "/api/providers" } as IncomingMessage,
        response as unknown as ServerResponse,
      ),
    ).toBe(true);
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body)).toEqual({ error: "probe failed" });
  });

  it("rejects malformed JSON and invalid benchmark configurations", async () => {
    const server = new EventEmitter();
    const websocketServer = attachWebSockets(server as unknown as HttpServer);
    const socket = new FakeWebSocket();
    websocketServer.emit("connection", socket);
    await flush();

    expect(socket.sent[0]).toMatchObject({ type: "providers" });

    socket.receive("{");
    socket.receive({ ...validRequest(), competitors: [{ id: "one", harness: "unknown", model: "x" }] });

    expect(socket.sent.slice(1)).toEqual([
      { type: "error", message: "Invalid JSON message." },
      { type: "error", message: "Invalid benchmark configuration." },
    ]);
    expect(mocks.runBenchmark).not.toHaveBeenCalled();
    socket.emit("close");
    websocketServer.close();
  });

  it("allows only one benchmark and cancels the active run", async () => {
    mocks.runBenchmark.mockImplementation((_request, _adapters, signal) => {
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const server = new EventEmitter();
    const websocketServer = attachWebSockets(server as unknown as HttpServer);
    const socket = new FakeWebSocket();
    websocketServer.emit("connection", socket);
    await flush();

    socket.receive(validRequest());
    socket.receive(validRequest());
    expect(socket.sent.at(-1)).toEqual({ type: "error", message: "A benchmark is already running." });

    socket.receive({ type: "cancel" });
    await flush();
    expect(socket.sent.at(-1)).toEqual({ type: "benchmark.cancelled" });
    expect(mocks.runBenchmark).toHaveBeenCalledTimes(1);
    expect(mocks.runBenchmark.mock.calls[0][2].aborted).toBe(true);
    socket.emit("close");
    websocketServer.close();
  });
});
