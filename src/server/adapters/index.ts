import { HARNESS_IDS, type HarnessId } from "../../shared/types.js";
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
export { defineAdapter } from "./types.js";
export type { AdapterProbeResult, AdapterRunInput, AdapterRunOutput, HarnessAdapter } from "./types.js";

export const adapterRegistry = {
  codex: codexAdapter,
  claudeAgent: claudeAdapter,
  cursor: cursorAdapter,
  grok: grokAdapter,
  opencode: openCodeAdapter,
} satisfies { [Id in HarnessId]: HarnessAdapter<Id> };

for (const id of HARNESS_IDS) {
  if (adapterRegistry[id].id !== id) {
    throw new Error(`Adapter registry key ${id} does not match adapter id ${adapterRegistry[id].id}.`);
  }
}

export const adapters: readonly HarnessAdapter[] = HARNESS_IDS.map((id) => adapterRegistry[id]);
