import type { HarnessId } from "../../shared/types.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { grokAdapter } from "./grok.js";
import { openCodeAdapter } from "./opencode.js";
import type { HarnessAdapter } from "./types.js";

export { claudeAdapter } from "./claude.js";
export { codexAdapter } from "./codex.js";
export { cursorAdapter } from "./cursor.js";
export { grokAdapter } from "./grok.js";
export { openCodeAdapter } from "./opencode.js";
export type { AdapterRunInput, AdapterRunOutput, HarnessAdapter } from "./types.js";

export const adapters: HarnessAdapter[] = [codexAdapter, claudeAdapter, cursorAdapter, grokAdapter, openCodeAdapter];

export function adapterFor(harness: HarnessId): HarnessAdapter {
  const adapter = adapters.find((candidate) => candidate.id === harness);
  if (!adapter) throw new Error(`No adapter registered for ${harness}.`);
  return adapter;
}
