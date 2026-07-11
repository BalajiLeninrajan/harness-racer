/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";

import { adapters } from "../server/adapters/index.js";
import { runBenchmark } from "../server/benchmark.js";
import { probeAdapters, type TerminalModeResult } from "../terminal.js";
import { TpsRacerApp } from "./app.js";
import { palette } from "./palette.js";

const SIGNAL_CLEANUP_TIMEOUT_MS = 2_500;

function waitForCleanup(shutdown: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, SIGNAL_CLEANUP_TIMEOUT_MS);
    void shutdown().then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

function terminalIdentity(env: NodeJS.ProcessEnv = process.env): string {
  return [env.TERM_PROGRAM, env.TERM, env.COLORTERM].filter(Boolean).join(" ").toLowerCase();
}

function useKittyKeyboard(env: NodeJS.ProcessEnv = process.env): boolean {
  const identity = terminalIdentity(env);
  return ["ghostty", "kitty", "wezterm", "iterm"].some((name) => identity.includes(name));
}

/** Start the native OpenTUI workbench. This entry intentionally runs only under Bun. */
export async function runOpenTui(): Promise<TerminalModeResult> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 60,
    screenMode: "alternate-screen",
    useMouse: true,
    // Clicks and scrolling stay enabled; disabling passive movement avoids a
    // stationary cursor changing focus after a streamed layout update.
    enableMouseMovement: false,
    useKittyKeyboard: useKittyKeyboard() ? { events: true } : null,
    backgroundColor: palette.canvas,
  });
  const root = createRoot(renderer);

  return new Promise<TerminalModeResult>((resolveResult, rejectResult) => {
    let settled = false;
    let shutdownBenchmark: () => Promise<void> = () => Promise.resolve();

    const cleanupSignals = () => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      process.off("SIGHUP", onTerminate);
    };

    const finish = (result: TerminalModeResult) => {
      if (settled) return;
      settled = true;
      cleanupSignals();
      const cleanup = waitForCleanup(shutdownBenchmark);
      try {
        root.unmount();
      } catch {
        // Renderer teardown still needs to run when React has already unmounted.
      }
      try {
        renderer.destroy();
      } catch {
        // The renderer may already be closing because the terminal disappeared.
      }
      // Signal teardown aborts the runner before unmount and waits for its
      // adapter/finally chain to reap child CLIs and temporary workspaces.
      void cleanup.then(() => resolveResult(result));
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanupSignals();
      try {
        root.unmount();
      } catch {}
      try {
        renderer.destroy();
      } catch {}
      rejectResult(error);
    };

    const onInterrupt = () => finish("cancelled");
    const onTerminate = () => finish("cancelled");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    process.once("SIGHUP", onTerminate);
    renderer.once("destroy", () => finish("cancelled"));

    try {
      root.render(
        <TpsRacerApp
          adapters={adapters}
          runBenchmark={runBenchmark}
          probeAdapters={probeAdapters}
          onExit={finish}
          onShutdownReady={(shutdown) => {
            shutdownBenchmark = shutdown;
          }}
        />,
      );
    } catch (error) {
      fail(error);
    }
  });
}
