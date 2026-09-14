import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import { runCommand } from "../src/server/adapters/lib/process.js";

// A child that reports nothing until the test says so.
function child() {
  return Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(function (this: { signalCode: NodeJS.Signals | null }, signal: NodeJS.Signals) {
      this.signalCode = signal;
      return true;
    }),
  });
}

describe("runCommand", () => {
  beforeEach(() => mocks.spawn.mockReset());
  afterEach(() => vi.useRealTimers());

  it("collects both streams and picks the first non-blank line, ANSI stripped, as the version line", async () => {
    const process = child();
    mocks.spawn.mockReturnValueOnce(process);

    const result = runCommand("tool", ["--version"], { cwd: "/tmp/run" });
    process.stdout.emit("data", "\n\u001b[32mtool 1.2\u001b[0m\nbuild abc\n");
    process.stderr.emit("data", "warning\n");
    process.exitCode = 0;
    process.emit("close", 0, null);

    await expect(result).resolves.toEqual({
      code: 0,
      stdout: "\n\u001b[32mtool 1.2\u001b[0m\nbuild abc\n",
      stderr: "warning\n",
      firstLine: "tool 1.2",
    });
    expect(mocks.spawn).toHaveBeenCalledWith("tool", ["--version"], expect.objectContaining({ cwd: "/tmp/run", shell: false, stdio: ["ignore", "pipe", "pipe"] }));
  });

  it("falls back to stderr for the first line when stdout is empty", async () => {
    const process = child();
    mocks.spawn.mockReturnValueOnce(process);
    const result = runCommand("tool", ["--version"]);
    process.stderr.emit("data", "tool: not signed in\n");
    process.emit("close", 1, null);
    await expect(result).resolves.toMatchObject({ code: 1, firstLine: "tool: not signed in" });
  });

  it("rejects with the spawn error when the command cannot start", async () => {
    const process = child();
    mocks.spawn.mockReturnValueOnce(process);
    const result = runCommand("tool", []);
    process.emit("error", Object.assign(new Error("spawn tool ENOENT"), { code: "ENOENT" }));
    await expect(result).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("kills the command with SIGKILL and rejects once the timeout elapses", async () => {
    vi.useFakeTimers();
    const process = child();
    mocks.spawn.mockReturnValueOnce(process);

    const result = expect(runCommand("agy", ["models"], { timeoutMs: 60_000 })).rejects.toThrow("agy models did not finish within 60s");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(process.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    await result;
    expect(process.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    // The close that follows the kill changes nothing.
    process.emit("close", null, "SIGKILL");
  });

  it("clears the timeout once the command has closed", async () => {
    vi.useFakeTimers();
    const process = child();
    mocks.spawn.mockReturnValueOnce(process);

    const result = runCommand("tool", [], { timeoutMs: 1_000 });
    process.stdout.emit("data", "ok\n");
    process.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toMatchObject({ code: 0, firstLine: "ok" });
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("kills the command and rejects with an AbortError when its signal fires", async () => {
    const process = child();
    mocks.spawn.mockReturnValueOnce(process);
    const controller = new AbortController();

    const result = runCommand("tool", [], { signal: controller.signal });
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(process.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });

  it("does not spawn for a signal that has already fired", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runCommand("tool", [], { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
