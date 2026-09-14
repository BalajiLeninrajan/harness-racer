import { spawn } from "node:child_process";

import { stripAnsi } from "./json.js";
import { abortError } from "./run.js";

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The first non-blank line of stdout, or of stderr when stdout is empty, with ANSI codes removed. */
  firstLine: string;
}

export interface RunCommandOptions {
  cwd?: string;
  /** The command is killed (SIGKILL) and the promise rejects once this elapses. */
  timeoutMs?: number;
  /** The command is killed and the promise rejects with an AbortError once this fires. */
  signal?: AbortSignal;
}

/**
 * Runs a one-shot command with stdin closed and both output streams
 * collected. Resolves on close with whatever exit code the command gave;
 * rejects only when it could not be spawned (ENOENT and friends), ran past
 * `timeoutMs`, or was aborted.
 */
export function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError());
      return;
    }
    const child = spawn(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const onAbort = () => finish(() => {
      kill();
      reject(abortError());
    });
    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => finish(() => {
        kill();
        reject(new Error(`${command} ${args.join(" ")} did not finish within ${Math.round(options.timeoutMs! / 1000)}s`));
      }), options.timeoutMs);
    timer?.unref();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("close", (code) => finish(() => resolve({ code, stdout, stderr, firstLine: firstLineOf(stdout, stderr) })));
  });
}

function firstLineOf(stdout: string, stderr: string): string {
  return stripAnsi(stdout || stderr).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}
