import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { TerminalModeResult, TerminalWriter } from "../terminal.js";

export interface TuiInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

export interface TuiOutput extends TerminalWriter {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  on?(event: "resize", listener: () => void): unknown;
  off?(event: "resize", listener: () => void): unknown;
}

export interface TerminalTuiOptions {
  input: TuiInput;
  output: TuiOutput;
  signal?: AbortSignal;
  handleSigint?: boolean;
}

const EXIT_RESULTS: Readonly<Record<number, TerminalModeResult>> = {
  0: "completed",
  2: "declined",
  3: "unavailable",
  130: "cancelled",
};

export function supportsTerminalTui(
  input: TuiInput,
  output: TuiOutput,
  term = process.env.TERM,
): boolean {
  return Boolean(
    input.isTTY &&
    output.isTTY &&
    typeof input.setRawMode === "function" &&
    typeof output.on === "function" &&
    typeof output.off === "function" &&
    term !== "dumb"
  );
}

/** Resolve the source entry under tsx and the sibling bundle after tsup. */
export function resolveTuiEntry(moduleUrl = import.meta.url): string {
  const modulePath = fileURLToPath(moduleUrl);
  const moduleDirectory = dirname(modulePath);
  const isSourceModule = basename(modulePath) === "index.ts" &&
    basename(moduleDirectory) === "tui" &&
    basename(dirname(moduleDirectory)) === "src";
  return isSourceModule
    ? resolve(moduleDirectory, "../tui-entry.ts")
    : resolve(moduleDirectory, "tui.js");
}

function resultForExit(code: number | null, signal: NodeJS.Signals | null): TerminalModeResult {
  if (signal === "SIGINT" || signal === "SIGTERM" || signal === "SIGHUP") return "cancelled";
  if (code === null) return "failed";
  return EXIT_RESULTS[code] ?? "failed";
}

export async function runTerminalTui(options: TerminalTuiOptions): Promise<TerminalModeResult> {
  if (options.signal?.aborted) return "cancelled";
  if (!supportsTerminalTui(options.input, options.output)) {
    throw new Error("The native terminal workbench requires an interactive TTY.");
  }
  if (options.input !== process.stdin || options.output !== process.stdout) {
    throw new Error("The native terminal workbench must own the process terminal streams. Use ui: \"line\" with custom streams.");
  }

  const bun = process.versions.bun
    ? process.execPath
    : process.env.TPS_RACER_BUN_BIN?.trim() || "bun";
  const entry = resolveTuiEntry();

  return new Promise<TerminalModeResult>((resolveResult) => {
    let settled = false;
    const child = spawn(bun, [entry], {
      stdio: "inherit",
      env: process.env,
    });

    const settle = (result: TerminalModeResult) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abortChild);
      if (options.handleSigint !== false) process.removeListener("SIGINT", interruptChild);
      process.removeListener("SIGTERM", terminateChild);
      process.removeListener("SIGHUP", hangupChild);
      resolveResult(result);
    };
    const abortChild = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    const interruptChild = () => {
      if (!child.killed) child.kill("SIGINT");
    };
    const terminateChild = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    const hangupChild = () => {
      if (!child.killed) child.kill("SIGHUP");
    };

    if (options.signal?.aborted) abortChild();
    else options.signal?.addEventListener("abort", abortChild, { once: true });
    if (options.handleSigint !== false) process.on("SIGINT", interruptChild);
    process.on("SIGTERM", terminateChild);
    process.on("SIGHUP", hangupChild);

    child.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        options.output.write(
          "TPS Racer's native terminal workbench requires Bun. Install Bun and make sure `bun` is on PATH.\n",
        );
        settle("unavailable");
        return;
      }
      options.output.write(`${error instanceof Error ? error.message : String(error)}\n`);
      settle("failed");
    });
    child.once("exit", (code, signal) => settle(resultForExit(code, signal)));
  });
}
