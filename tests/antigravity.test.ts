import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), settings: undefined as string | undefined }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:os", () => ({ homedir: () => "/home/racer" }));
vi.mock("node:fs", () => ({
  readFileSync: () => {
    if (mocks.settings === undefined) throw new Error("ENOENT");
    return mocks.settings;
  },
}));

type FakeChild = EventEmitter & {
  stdin: { write: ReturnType<typeof vi.fn> };
  stdout: EventEmitter & { setEncoding: () => void };
  stderr: EventEmitter & { setEncoding: () => void };
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
  messages: Array<Record<string, unknown>>;
};

const MODEL_LIST = "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n";

function commandProcess(stdout: string, stderr = "", code = 0): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = { write: vi.fn() };
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  child.exitCode = code;
  child.signalCode = null;
  child.kill = vi.fn();
  child.messages = [];
  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", stdout);
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("close", code, null);
  });
  return child;
}

function sessionProcess(options: { failTurn?: boolean } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  child.exitCode = null;
  child.signalCode = null;
  child.messages = [];
  child.kill = vi.fn((signal: NodeJS.Signals) => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  });
  const emit = (event: Record<string, unknown>) => child.stdout.emit("data", `${JSON.stringify(event)}\n`);
  child.stdin = {
    write: vi.fn((line: string) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      child.messages.push(message);
      if (message.event !== "user") {
        queueMicrotask(() => {
          emit({ event: "init", conversation_id: "conv-1", init: { model: "gemini-3.8-flash-low", cwd: "/tmp/run", tools: [] } });
          child.stderr.emit("data", `warning: ignoring unsupported stream input message event "${String(message.event)}"\n`);
        });
        return true;
      }
      queueMicrotask(() => {
        emit({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 0, state: "DONE", step_type: "user_input" } });
        emit({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 1, state: "ACTIVE", step_type: "agent_thought", text_delta: "thinking" } });
        emit({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: "hel" } });
        emit({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 2, state: "DONE", step_type: "agent_response", text_delta: "lo\n", usage: { output_tokens: 3 } } });
        emit(options.failTurn
          ? { event: "result", result: { conversation_id: "conv-1", status: "ERROR", error: "model unavailable", usage: { output_tokens: 0 } } }
          : { event: "result", result: { conversation_id: "conv-1", status: "SUCCESS", response: "hello\n", usage: { input_tokens: 5, output_tokens: 3, thinking_tokens: 0 } } });
      });
      return true;
    }),
  };
  return child;
}

async function loadAdapter() {
  return (await import("../src/server/adapters/antigravity.js")).antigravityAdapter;
}

describe("Antigravity adapter", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.spawn.mockReset();
    mocks.settings = undefined;
  });

  it("reports the CLI as missing when agy cannot be spawned", async () => {
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter() as FakeChild;
      child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
      child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
      queueMicrotask(() => child.emit("error", new Error("spawn agy ENOENT")));
      return child;
    });
    const adapter = await loadAdapter();
    const result = await adapter.probe();
    expect(result).toMatchObject({ installed: false, authenticated: null, models: [] });
    expect(result.message).toContain("ENOENT");
  });

  it("lists models from agy models and marks the settings model as default", async () => {
    mocks.settings = JSON.stringify({ model: "Gemini 3.8 Flash (Low)" });
    mocks.spawn
      .mockImplementationOnce(() => commandProcess("1.1.28\n"))
      .mockImplementationOnce(() => commandProcess(MODEL_LIST, "Fetching available models...\n"));
    const adapter = await loadAdapter();
    const result = await adapter.probe();

    expect(result).toMatchObject({
      installed: true,
      authenticated: true,
      version: "1.1.28",
      defaultModel: "gemini-3.8-flash-low",
      models: [
        { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
        { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)", isDefault: true },
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
      ],
    });
    expect(mocks.spawn).toHaveBeenNthCalledWith(1, "agy", ["--version"], expect.objectContaining({ shell: false }));
    expect(mocks.spawn).toHaveBeenNthCalledWith(2, "agy", ["models"], expect.objectContaining({ shell: false }));
  });

  it("reports a signed-out CLI as unauthenticated", async () => {
    mocks.spawn
      .mockImplementationOnce(() => commandProcess("1.1.28\n"))
      .mockImplementationOnce(() => commandProcess("", "Please sign in to view available models. Launch the CLI without arguments to sign in.\n", 1));
    const adapter = await loadAdapter();
    const result = await adapter.probe();
    expect(result).toMatchObject({ installed: true, authenticated: false, version: "1.1.28", models: [] });
    expect(result.message).toContain("sign in");
  });

  it("readies the lane on init, prompts at the start signal, streams response deltas, and reports native tokens", async () => {
    const children: FakeChild[] = [];
    mocks.spawn.mockImplementation(() => {
      const child = sessionProcess();
      children.push(child);
      return child;
    });
    const adapter = await loadAdapter();
    const deltas: string[] = [];
    const order: string[] = [];
    const result = await adapter.run({
      cwd: "/tmp/run",
      model: "gemini-3.8-flash-low",
      prompt: "Reply",
      signal: new AbortController().signal,
      onReady: () => order.push("ready"),
      waitForStart: async () => { order.push("start"); },
      onDelta: (text) => deltas.push(text),
    });

    expect(order).toEqual(["ready", "start"]);
    expect(deltas).toEqual(["hel", "lo\n"]);
    expect(result).toEqual({ nativeOutputTokens: 3 });
    expect(mocks.spawn).toHaveBeenCalledWith(
      "agy",
      ["--input-format", "stream-json", "--output-format", "stream-json", "--model", "gemini-3.8-flash-low", "--print="],
      expect.objectContaining({ cwd: "/tmp/run", shell: false }),
    );
    expect(children[0]?.messages).toEqual([
      { event: "harness-racer/ready" },
      { event: "user", message: { role: "user", content: "Reply" } },
    ]);
    expect(children[0]?.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("fails the run when the CLI reports an error result", async () => {
    mocks.spawn.mockImplementation(() => sessionProcess({ failTurn: true }));
    const adapter = await loadAdapter();
    await expect(adapter.run({
      cwd: "/tmp/run", model: "gemini-9", prompt: "x", signal: new AbortController().signal,
      onReady: vi.fn(), waitForStart: async () => {}, onDelta: vi.fn(),
    })).rejects.toThrow(/model unavailable/);
  });

  it("fails the run when the CLI exits before it is ready", async () => {
    mocks.spawn.mockImplementation(() => {
      const child = sessionProcess();
      child.stdin.write = vi.fn(() => {
        queueMicrotask(() => {
          child.stderr.emit("data", "Error: unknown model\n");
          child.exitCode = 2;
          child.emit("close", 2, null);
        });
        return true;
      });
      return child;
    });
    const adapter = await loadAdapter();
    const onReady = vi.fn();
    await expect(adapter.run({
      cwd: "/tmp/run", model: "nope", prompt: "x", signal: new AbortController().signal,
      onReady, waitForStart: async () => {}, onDelta: vi.fn(),
    })).rejects.toThrow(/exited with code 2: Error: unknown model/);
    expect(onReady).toHaveBeenCalledOnce();
  });

  it("rejects an already-aborted run without spawning", async () => {
    const adapter = await loadAdapter();
    const controller = new AbortController();
    controller.abort();
    await expect(adapter.run({
      cwd: "/tmp", model: "gemini-3.8-flash-low", prompt: "x", signal: controller.signal,
      onReady: vi.fn(), waitForStart: async () => {}, onDelta: vi.fn(),
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
