import type { SamplePreset } from "../shared/types.js";

export const MAX_RACERS = 6;
export const SAMPLE_PRESETS = ["quick", "standard", "thorough"] as const satisfies readonly SamplePreset[];
