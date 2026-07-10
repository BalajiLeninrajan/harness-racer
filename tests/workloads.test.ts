import { describe, expect, it } from "vitest";
import { validateOutput, workloads } from "../src/server/workloads.js";

describe("workloads", () => {
  it("contains separate deterministic prose and code heats", () => {
    expect(workloads.map((workload) => workload.id)).toEqual(["prose", "code"]);
    for (const workload of workloads) {
      expect(workload.prompt).toContain(workload.corpus);
      expect(workload.corpus.length).toBeGreaterThan(500);
    }
  });

  it("accepts only the fixed corpus with an optional final newline", () => {
    const corpus = workloads[0].corpus;
    expect(validateOutput(`${corpus}\n`, corpus).valid).toBe(true);
    expect(validateOutput(`prefix ${corpus}`, corpus).valid).toBe(false);
  });
});
