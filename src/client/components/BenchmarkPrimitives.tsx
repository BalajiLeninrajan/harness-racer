import type { HarnessId } from "../../shared/types";
import { ModelLabLogo } from "../BrandLogo";

export function ModelMark({ harness, model }: { harness: HarnessId; model: string }) {
  return (
    <span className={`harness-mark harness-${harness}`} aria-hidden="true">
      <ModelLabLogo harness={harness} model={model} size={16} />
    </span>
  );
}

export function Metric({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`metric ${accent ? "metric-accent" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
