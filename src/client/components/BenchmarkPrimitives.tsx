import type { HarnessId } from "../../shared/types";
import { ModelLabLogo } from "../BrandLogo";

export function ModelMark({ harness, model }: { harness: HarnessId; model: string }) {
  return (
    <span className={`harness-mark harness-${harness}`} aria-hidden="true">
      <ModelLabLogo harness={harness} model={model} size={16} />
    </span>
  );
}

/* A label over its value. `hero` is the package's large accent value; it
   stays muted until `accent` says a live reading has arrived. */
export function Metric({ label, value, accent, hero }: { label: string; value: string; accent?: boolean; hero?: boolean }) {
  return (
    <div className={`stat ${hero ? "is-lg" : ""} ${accent ? "is-live" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
