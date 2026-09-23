import type { AdapterRunInput, AdapterRunOutput } from "../types.js";

// How long a harness gets to stop its turn on its own (Codex's turn/interrupt
// round trip) before its process is killed anyway.
const CANCEL_GRACE_MS = 800;

/** The error every adapter rejects with once its run signal has fired. */
export function abortError(): Error {
  const error = new Error("Benchmark cancelled");
  error.name = "AbortError";
  return error;
}

/**
 * Settles with the promise, or rejects with the signal's reason as soon as it
 * aborts, so nothing keeps waiting on work that ignores its signal.
 */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    // The promise is observed even when the signal was already aborted: the
    // caller has started the work, and its rejection must not go unhandled.
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Resolves once the promise settles, or after the grace period if it does not. */
export function settledWithin(promise: Promise<unknown>, graceMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, graceMs);
    promise.catch(() => undefined).finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export interface OpenContext {
  cwd: string;
  model: string;
  /** The run signal. Pass it into every request made while opening. */
  signal: AbortSignal;
  onDelta: (text: string) => void;
  /**
   * Registers a teardown step: a kill, a close, an abort of an SDK controller.
   * Call it the moment a child is spawned, before the first handshake byte, so
   * a handshake that stalls can still be killed. Steps run once, in the order
   * they were registered, when the run ends for any reason. A step registered
   * after teardown has already run is run at once.
   */
  onCleanup: (fn: () => void) => void;
}

/**
 * What differs between harnesses. Everything else about a run (the abort
 * listener, when ready is declared, the start barrier, the cancel grace, the
 * teardown) is the same for all of them and lives in runSession.
 */
export interface SessionPlan<Session, Result = unknown> {
  /**
   * Spawns and authenticates the harness and opens a session on ctx.model.
   * The lane is declared ready when this resolves, so everything that belongs
   * to harness prep goes here, and nothing that belongs to the prompt does.
   */
  open(ctx: OpenContext): Promise<Session>;
  /**
   * Sends the prompt and resolves once the turn is over, streaming visible
   * text through the onDelta given to open. Must settle once the signal fires.
   */
  prompt(session: Session, text: string, signal: AbortSignal): Promise<Result>;
  /**
   * Asks the harness to stop the turn in flight. Called on abort while a prompt
   * is pending and awaited for a short grace before the session is torn down.
   */
  cancel?(session: Session): void | Promise<void>;
  /** Reads the harness's own output-token count from what prompt resolved with. */
  tokens?(result: Result): number | undefined;
}

/**
 * Runs one lane the way AdapterRunInput's contract describes, with the
 * harness-specific steps supplied by the plan.
 */
export async function runSession<Session, Result>(
  input: AdapterRunInput,
  plan: SessionPlan<Session, Result>,
): Promise<AdapterRunOutput> {
  if (input.signal.aborted) throw abortError();
  const cleanups: Array<() => void> = [];
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const step of cleanups) {
      try {
        step();
      } catch {
        // A teardown that fails has nothing left to report to.
      }
    }
  };
  let session: Session | undefined;
  let prompting = false;
  let cancelling: Promise<void> | undefined;
  const onAbort = () => {
    if (session === undefined || !prompting || !plan.cancel) {
      cleanup();
      return;
    }
    const current = session;
    // Deferred a tick so a reply that is already on its way (the turn id the
    // harness returned for the prompt) has been recorded by the time the
    // harness is asked to stop that turn.
    cancelling = settledWithin(Promise.resolve().then(() => plan.cancel?.(current)), CANCEL_GRACE_MS);
    void cancelling.then(cleanup);
  };
  input.signal.addEventListener("abort", onAbort, { once: true });

  try {
    session = await plan.open({
      cwd: input.cwd,
      model: input.model,
      signal: input.signal,
      onDelta: input.onDelta,
      onCleanup: (step) => {
        if (cleanedUp) step();
        else cleanups.push(step);
      },
    });
    if (input.signal.aborted) throw abortError();
    input.onReady();
    await untilAborted(input.waitForStart(), input.signal);
    if (input.signal.aborted) throw abortError();
    prompting = true;
    const result = await plan.prompt(session, input.prompt, input.signal);
    prompting = false;
    if (input.signal.aborted) throw abortError();
    const tokens = plan.tokens?.(result);
    return tokens === undefined ? {} : { nativeOutputTokens: tokens };
  } catch (error) {
    if (input.signal.aborted) throw abortError();
    throw error;
  } finally {
    input.signal.removeEventListener("abort", onAbort);
    if (cancelling) await cancelling;
    cleanup();
  }
}
