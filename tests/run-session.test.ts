import { afterEach, describe, expect, it, vi } from "vitest";
import { runSession, type OpenContext, type SessionPlan } from "../src/server/adapters/lib/run.js";

function runInput(signal = new AbortController().signal) {
  return {
    model: "m",
    prompt: "Reply",
    cwd: "/tmp/run",
    signal,
    onReady: vi.fn(),
    waitForStart: vi.fn(async () => {}),
    onDelta: vi.fn(),
  };
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function plan(overrides: Partial<SessionPlan<string, unknown>> = {}): SessionPlan<string, unknown> {
  return {
    open: async () => "session",
    prompt: async () => ({}),
    ...overrides,
  };
}

describe("runSession", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens, declares ready once, waits at the barrier, then prompts", async () => {
    const order: string[] = [];
    const input = {
      ...runInput(),
      onReady: vi.fn(() => { order.push("ready"); }),
      waitForStart: vi.fn(async () => { order.push("start"); }),
    };
    const result = await runSession(input, plan({
      open: async (ctx) => { order.push(`open:${ctx.model}`); return "session"; },
      prompt: async (session, text) => { order.push(`prompt:${session}:${text}`); return { count: 5 }; },
      tokens: (result) => (result as { count: number }).count,
    }));

    expect(order).toEqual(["open:m", "ready", "start", "prompt:session:Reply"]);
    expect(input.onReady).toHaveBeenCalledOnce();
    expect(result).toEqual({ nativeOutputTokens: 5 });
  });

  it("returns no token count when the plan reads none", async () => {
    await expect(runSession(runInput(), plan({ tokens: () => undefined }))).resolves.toEqual({});
    await expect(runSession(runInput(), plan())).resolves.toEqual({});
  });

  it("rejects an already-aborted run without opening anything", async () => {
    const controller = new AbortController();
    controller.abort();
    const open = vi.fn(async () => "session");

    await expect(runSession(runInput(controller.signal), plan({ open }))).rejects.toMatchObject({ name: "AbortError" });
    expect(open).not.toHaveBeenCalled();
  });

  it("never declares ready when setup fails, and still tears down", async () => {
    const kill = vi.fn();
    const input = runInput();

    await expect(runSession(input, plan({
      open: async (ctx) => {
        ctx.onCleanup(kill);
        throw new Error("not signed in");
      },
    }))).rejects.toThrow("not signed in");

    expect(input.onReady).not.toHaveBeenCalled();
    expect(input.waitForStart).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledOnce();
  });

  it("kills a handshake that stalls when the run is cancelled during setup", async () => {
    const controller = new AbortController();
    const kill = vi.fn();
    let opening!: () => void;
    const spawned = new Promise<void>((resolve) => { opening = resolve; });
    const input = runInput(controller.signal);

    const run = runSession(input, plan({
      open: async (ctx) => {
        // Registered the moment the child exists, before the handshake.
        ctx.onCleanup(kill);
        opening();
        return never();
      },
    }));
    await spawned;
    expect(kill).not.toHaveBeenCalled();
    controller.abort(new Error("Benchmark cancelled."));
    expect(kill).toHaveBeenCalledOnce();

    // open() never settles, so the run is freed by the engine, not by the
    // adapter; nothing here waits on it. The lane's own view is what matters:
    await Promise.race([run.catch(() => "rejected"), new Promise((resolve) => setTimeout(resolve, 20, "pending"))]);
    expect(input.onReady).not.toHaveBeenCalled();
  });

  it("surfaces a cancel during setup as an AbortError even when the plan reports its own error", async () => {
    const controller = new AbortController();
    const input = runInput(controller.signal);

    const run = runSession(input, plan({
      open: (ctx) => new Promise((_resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("Grok ACP exited with signal SIGTERM")), { once: true });
      }),
    }));
    controller.abort(new Error("Benchmark cancelled."));

    await expect(run).rejects.toMatchObject({ name: "AbortError", message: "Benchmark cancelled" });
    expect(input.onReady).not.toHaveBeenCalled();
  });

  it("runs a teardown step registered after teardown at once", async () => {
    const controller = new AbortController();
    const late = vi.fn();
    let ctx!: OpenContext;
    let opening!: () => void;
    const spawned = new Promise<void>((resolve) => { opening = resolve; });

    void runSession(runInput(controller.signal), plan({
      open: async (context) => { ctx = context; opening(); return never(); },
    })).catch(() => undefined);
    await spawned;
    controller.abort(new Error("Benchmark cancelled."));
    ctx.onCleanup(late);

    expect(late).toHaveBeenCalledOnce();
  });

  it("leaves the start barrier when the run is cancelled while waiting there", async () => {
    const controller = new AbortController();
    const kill = vi.fn();
    const prompt = vi.fn(async () => ({}));
    const input = { ...runInput(controller.signal), waitForStart: vi.fn(() => never<void>()) };

    const run = runSession(input, plan({ open: async (ctx) => { ctx.onCleanup(kill); return "session"; }, prompt }));
    await vi.waitFor(() => expect(input.waitForStart).toHaveBeenCalled());
    controller.abort(new Error("Benchmark cancelled."));

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(prompt).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledOnce();
  });

  it("does not ask the harness to cancel a turn that was never started", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const input = { ...runInput(controller.signal), waitForStart: vi.fn(() => never<void>()) };

    const run = runSession(input, plan({ cancel }));
    await vi.waitFor(() => expect(input.waitForStart).toHaveBeenCalled());
    controller.abort(new Error("Benchmark cancelled."));

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("rejects when the run was cancelled even though the prompt resolved", async () => {
    const controller = new AbortController();
    const input = runInput(controller.signal);

    await expect(runSession(input, plan({
      prompt: async () => {
        // A cut-short process can still end its stream cleanly.
        controller.abort(new Error("Benchmark cancelled."));
        return { count: 3 };
      },
      tokens: () => 3,
    }))).rejects.toMatchObject({ name: "AbortError" });
  });

  it("asks the harness to stop the turn and waits for it before tearing down", async () => {
    const controller = new AbortController();
    const order: string[] = [];
    let interrupted!: () => void;
    const interrupt = new Promise<void>((resolve) => { interrupted = resolve; });
    const input = runInput(controller.signal);

    const run = runSession(input, plan({
      open: async (ctx) => { ctx.onCleanup(() => order.push("kill")); return "session"; },
      prompt: (_session, _text, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
      }),
      cancel: async () => {
        order.push("cancel");
        await interrupt;
        order.push("cancelled");
      },
    }));
    await vi.waitFor(() => expect(input.waitForStart).toHaveBeenCalled());
    controller.abort(new Error("Benchmark cancelled."));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["cancel"]);
    interrupted();

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(order).toEqual(["cancel", "cancelled", "kill"]);
  });

  it("tears down anyway when the harness does not answer the cancel in time", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const kill = vi.fn();
    const input = runInput(controller.signal);

    const run = runSession(input, plan({
      open: async (ctx) => { ctx.onCleanup(kill); return "session"; },
      prompt: () => never(),
      cancel: () => never<void>(),
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(input.waitForStart).toHaveBeenCalled();
    controller.abort(new Error("Benchmark cancelled."));

    await vi.advanceTimersByTimeAsync(799);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(kill).toHaveBeenCalledOnce();
    // The prompt itself ignores the signal; the engine frees the lane in that
    // case, so the adapter's promise is not awaited here.
    void run.catch(() => undefined);
  });

  it("passes the run's cwd, model and delta sink to the plan", async () => {
    const input = runInput();
    let seen: Pick<OpenContext, "cwd" | "model" | "signal"> | undefined;

    await runSession(input, plan({
      open: async (ctx) => {
        seen = { cwd: ctx.cwd, model: ctx.model, signal: ctx.signal };
        ctx.onDelta("hi");
        return "session";
      },
    }));

    expect(seen).toEqual({ cwd: "/tmp/run", model: "m", signal: input.signal });
    expect(input.onDelta).toHaveBeenCalledWith("hi");
  });
});
