import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { BenchmarkRequest, ClientMessage, ServerEvent } from "../shared/types.js";
import { adapters } from "./adapters/index.js";
import { runBenchmark } from "./benchmark.js";

function send(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
}

export async function getProviders() {
  return Promise.all(adapters.map((adapter) => adapter.probe()));
}

export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== "GET" || req.url !== "/api/providers") return false;
  try {
    const providers = await getProviders();
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ providers }));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
  return true;
}

function isBenchmarkRequest(value: unknown): value is BenchmarkRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<BenchmarkRequest>;
  return (
    request.type === "start" &&
    (request.mode === "parallel" || request.mode === "sequential") &&
    (request.samplePreset === "quick" || request.samplePreset === "standard" || request.samplePreset === "thorough") &&
    Array.isArray(request.competitors) &&
    request.competitors.length >= 2 &&
    request.competitors.length <= 6 &&
    request.competitors.every(
      (competitor) =>
        competitor &&
        typeof competitor.id === "string" &&
        (competitor.harness === "codex" || competitor.harness === "claudeAgent" || competitor.harness === "cursor" || competitor.harness === "grok" || competitor.harness === "opencode") &&
        typeof competitor.model === "string" &&
        competitor.model.length > 0,
    )
  );
}

export function attachWebSockets(server: HttpServer): WebSocketServer {
  const websocketServer = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const host = request.headers.host;
    const origin = request.headers.origin;
    if (request.url !== "/ws" || (origin && host && new URL(origin).host !== host)) {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  websocketServer.on("connection", (websocket) => {
    let active: AbortController | undefined;

    void getProviders()
      .then((providers) => send(websocket, { type: "providers", providers }))
      .catch((error) => send(websocket, { type: "error", message: error instanceof Error ? error.message : String(error) }));

    websocket.on("message", (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        send(websocket, { type: "error", message: "Invalid JSON message." });
        return;
      }

      if (message.type === "cancel") {
        active?.abort(new Error("Benchmark cancelled."));
        return;
      }

      if (!isBenchmarkRequest(message)) {
        send(websocket, { type: "error", message: "Invalid benchmark configuration." });
        return;
      }
      if (active) {
        send(websocket, { type: "error", message: "A benchmark is already running." });
        return;
      }

      active = new AbortController();
      void runBenchmark(message, adapters, active.signal, (event) => send(websocket, event))
        .catch((error) => {
          if (active?.signal.aborted) send(websocket, { type: "benchmark.cancelled" });
          else send(websocket, { type: "error", message: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          active = undefined;
        });
    });

    websocket.on("close", () => active?.abort(new Error("Browser disconnected.")));
  });

  return websocketServer;
}
