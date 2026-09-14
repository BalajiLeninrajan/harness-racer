import type { HarnessId, ProviderInfo } from "../../shared/types.js";

/**
 * What the engine hands an adapter's run(), and what it expects back. Every
 * adapter follows the same lifecycle; lib/run.ts implements it once, so an
 * adapter normally supplies a SessionPlan instead of writing this out.
 *
 * 1. Listen on `signal` before any process work, so a cancel or timeout that
 *    lands during the handshake still reaches the child.
 * 2. Spawn, authenticate and open a session on `model`, then call `onReady`
 *    exactly once. Never call it when setup fails: the engine releases the
 *    parallel start barrier on rejection by itself, and a ready status right
 *    before an error would be measured as harness prep for a failed lane.
 * 3. Await `waitForStart` raced against `signal`, with no timeout of the
 *    adapter's own. The wait itself is unbounded by design. The barrier
 *    opens when the last lane is ready or the first lane fails, and a lane
 *    stuck in setup fails on its own setup timer, so a ready lane only ever
 *    waits on lanes that are still on the clock.
 * 4. Send `prompt`, streaming visible text through `onDelta`. Resolve once
 *    the turn is over, with the harness's own token count if it reports one.
 * 5. Reject with an AbortError once `signal` has fired, even if the prompt
 *    resolved in the meantime: what a cut-short process returned is not a
 *    result. Ask the harness to stop its turn first, waiting a short bound
 *    for it, then tear the process down.
 */
export interface AdapterRunInput {
  model: string;
  prompt: string;
  cwd: string;
  /** Fires on cancel or timeout. The reason on it is the engine's, not the adapter's. */
  signal: AbortSignal;
  /** Setup is done and the prompt can be sent. Once per run, never on failure. */
  onReady: () => void;
  /** Resolves when every lane in the heat is ready. Race it against `signal`. */
  waitForStart: () => Promise<void>;
  onDelta: (text: string) => void;
}

export interface AdapterRunOutput {
  nativeOutputTokens?: number;
}

export type AdapterProbeResult = Omit<ProviderInfo, "id" | "name" | "command">;

export interface HarnessAdapter<Id extends HarnessId = HarnessId> {
  readonly id: Id;
  readonly name: string;
  readonly command: string;
  probe(): Promise<ProviderInfo>;
  run(input: AdapterRunInput): Promise<AdapterRunOutput>;
}

type AdapterMetadata<Id extends HarnessId> = Pick<HarnessAdapter<Id>, "id" | "name" | "command">;
type AdapterImplementation = Pick<HarnessAdapter, "run"> & {
  probe(): Promise<AdapterProbeResult>;
};

export function defineAdapter<const Id extends HarnessId>(
  metadata: AdapterMetadata<Id>,
  implementation: AdapterImplementation,
): HarnessAdapter<Id> {
  return {
    ...metadata,
    run: implementation.run,
    async probe() {
      return { ...(await implementation.probe()), ...metadata };
    },
  };
}
