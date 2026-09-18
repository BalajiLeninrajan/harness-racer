import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import open from "open";
import sirv from "sirv";
import { attachWebSockets, handleApi } from "./server/app.js";

export interface WebOptions {
  dev: boolean;
  open: boolean;
  port: number;
}

export async function runWeb(options: WebOptions): Promise<void> {
  let viteMiddleware: ((req: Parameters<typeof handleApi>[0], res: Parameters<typeof handleApi>[1]) => void) | undefined;
  let closeVite: (() => Promise<void>) | undefined;

  if (options.dev) {
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
  // Hashed assets can live in the browser cache forever. Everything else,
  // index.html above all, must revalidate on every load, or a browser that
  // saw an older release keeps running its bundle after an upgrade.
  const staticHandler = sirv(staticDir, {
    single: true,
    dev: false,
    setHeaders(res, pathname) {
      res.setHeader(
        "cache-control",
        pathname.startsWith("/assets/") ? "public,max-age=31536000,immutable" : "no-cache",
      );
    },
  });

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
    await listen(options.port);
  } catch (error) {
    if (options.port === 0 || !(error instanceof Error) || !("code" in error) || error.code !== "EADDRINUSE") {
      throw error;
    }
    console.warn(`Port ${options.port} is busy; using an available local port instead.`);
    await listen(0);
  }

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine local server address.");
  const url = `http://127.0.0.1:${address.port}`;
  console.log(`Harness Racer is ready: ${url}`);
  if (options.open) await open(url);

  const shutdown = async () => {
    webSockets.clients.forEach((client) => client.close());
    webSockets.close();
    await closeVite?.();
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
