import type { HarnessId, ProviderInfo } from "../../shared/types.js";

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
