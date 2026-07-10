import type { HarnessId, ModelOption, ProviderInfo } from "../../shared/types.js";

export interface AdapterRunInput {
  model: string;
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  onReady: () => void;
  waitForStart: () => Promise<void>;
  onDelta: (text: string) => void;
}

export interface AdapterRunOutput {
  nativeOutputTokens?: number;
}

export interface HarnessAdapter {
  id: HarnessId;
  name: string;
  command: string;
  probe(): Promise<ProviderInfo>;
  listModels(): Promise<ModelOption[]>;
  run(input: AdapterRunInput): Promise<AdapterRunOutput>;
}
