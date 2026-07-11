import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import open from "open";
import sirv from "sirv";
import { attachWebSockets, handleApi } from "./server/app.js";

const args = new Set(process.argv.slice(2));
const isDev = args.has("--dev");
const shouldOpen = !args.has("--no-open");
const portArg = process.argv.findIndex((arg) => arg === "--port");
const requestedPort = portArg >= 0 ? Number(process.argv[portArg + 1]) : 4317;

const help = `TPS Racer

Usage: tps-racer [options]

Options:
  --cli          Open the native terminal workbench (requires Bun)
  --no-open      Start the browser app without opening it automatically
  --port <port>  Set the browser app's loopback port (default: 4317)
  -h, --help     Show this help

Terminal workbench:
  Mouse           Select racers and scroll output
  Arrows          Navigate the roster or leaderboard
  Tab             Focus the next racer pane
  Space           Select or remove a racer
  Enter           Start the race
  S               Open the racer roster
  I               Open the race inspector
  Ctrl-P          Open the command palette
  Ctrl-C          Stop the active race or exit
  Q               Stop an active race or quit

The browser app runs on Node. The native terminal workbench uses OpenTUI and
launches through Bun; install Bun and make sure it is on PATH.

Examples:
  tps-racer --cli
  tps-racer --no-open --port 4317
`;

async function main(): Promise<void> {
  if (args.has("--help") || args.has("-h")) {
    console.log(help);
    return;
  }

  if (args.has("--cli")) {
    const { runTerminalMode } = await import("./terminal.js");
    const result = await runTerminalMode({ ui: "tui" });
    if (result === "failed" || result === "unavailable") process.exitCode = 1;
    if (result === "cancelled") process.exitCode = 130;
    return;
  }

  let viteMiddleware: ((req: Parameters<typeof handleApi>[0], res: Parameters<typeof handleApi>[1]) => void) | undefined;
  let closeVite: (() => Promise<void>) | undefined;

  if (isDev) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    viteMiddleware = vite.middlewares;
    closeVite = () => vite.close();
  }

  const currentDir = dirname(fileURLToPath(import.meta.url));
  const staticDir = resolve(currentDir, "client");
  const staticHandler = sirv(staticDir, { single: true, dev: false });

  const server = createServer((req, res) => {
    void handleApi(req, res).then((handled) => {
      if (handled) return;
      if (viteMiddleware) viteMiddleware(req, res);
      else staticHandler(req, res);
    });
  });
  const webSockets = attachWebSockets(server);

  const listen = (port: number) =>
    new Promise<void>((resolveListen, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        resolveListen();
      });
    });

  try {
    await listen(requestedPort);
  } catch (error) {
    if (requestedPort === 0 || !(error instanceof Error) || !("code" in error) || error.code !== "EADDRINUSE") {
      throw error;
    }
    console.warn(`Port ${requestedPort} is busy; using an available local port instead.`);
    await listen(0);
  }

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine local server address.");
  const url = `http://127.0.0.1:${address.port}`;
  console.log(`TPS Racer is ready: ${url}`);
  if (shouldOpen) await open(url);

  const shutdown = async () => {
    webSockets.clients.forEach((client) => client.close());
    webSockets.close();
    await closeVite?.();
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
