import type { HarnessId } from "../../shared/types";
import { ModelLabLogo } from "../BrandLogo";

export function ModelMark({ harness, model }: { harness: HarnessId; model: string }) {
  return (
    <span className={`harness-mark harness-${harness}`} aria-hidden="true">
      <ModelLabLogo harness={harness} model={model} size={16} />
    </span>
  );
}

/* Label-then-value in the DOM so it reads as "visible tok/s, 38.4"; the lane
   flips it visually. `hero` is the package's headline-metric treatment. */
export function Metric({ label, value, accent, hero }: { label: string; value: string; accent?: boolean; hero?: boolean }) {
  return (
    <div className={`metric ${hero ? "is-hero" : ""} ${accent ? "metric-accent" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
