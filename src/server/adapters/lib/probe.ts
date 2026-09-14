import type { ModelOption } from "../../../shared/types.js";
import type { AdapterProbeResult } from "../types.js";
import { errorMessage, recordFrom } from "./json.js";

export interface ModelList {
  models: ModelOption[];
  defaultModel?: string;
}

/**
 * Makes a probe's model list safe to hand to the clients: ids are unique,
 * `defaultModel` names a listed entry or is absent, and exactly one entry
 * carries `isDefault`. `preferred` is what the harness says it would use
 * (its configured or current model); it wins when it is listed, then an
 * entry the harness flagged as default, then the first entry.
 */
export function normalizeModels(models: ModelOption[], preferred?: string): ModelList {
  const byId = new Map<string, ModelOption>();
  for (const model of models) if (!byId.has(model.id)) byId.set(model.id, model);
  const unique = [...byId.values()];
  const defaultModel = unique.find((model) => model.id === preferred)?.id
    ?? unique.find((model) => model.isDefault)?.id
    ?? unique[0]?.id;
  return {
    models: unique.map(({ isDefault: _flag, ...model }) => (model.id === defaultModel ? { ...model, isDefault: true } : model)),
    ...(defaultModel === undefined ? {} : { defaultModel }),
  };
}

/** Whether a spawn failure says the executable is not on PATH, as opposed to present but failing. */
export function notInstalled(error: unknown): boolean {
  for (let current = error; current !== undefined; current = recordFrom(current)?.cause) {
    if (recordFrom(current)?.code === "ENOENT") return true;
  }
  return false;
}

/**
 * The result for a probe that could not read the harness. `installed` is
 * false only when the executable is absent; a CLI that crashes, times out or
 * exits non-zero is there, and is reported as installed with no models so the
 * failure stays visible next to it rather than hiding the harness.
 */
export function probeFailure(error: unknown, version?: string): AdapterProbeResult {
  return {
    installed: !notInstalled(error),
    authenticated: null,
    models: [],
    ...(version === undefined ? {} : { version }),
    message: errorMessage(error),
  };
}

/**
 * Bounds a probe step. On timeout `onTimeout` tears down whatever the step
 * is waiting on (a kill, a terminate, an abort) so nothing is left running,
 * and the result rejects with `message`.
 */
export function bounded<T>(work: Promise<T>, timeoutMs: number, message: string, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
      onTimeout();
    }, timeoutMs);
    timer.unref();
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
