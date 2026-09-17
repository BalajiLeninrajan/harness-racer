import { describe, expect, it } from "vitest";
import { makeCompetitor, nextColor } from "../src/client/benchmark.js";
import type { Competitor, ProviderInfo } from "../src/shared/types.js";

const provider: ProviderInfo = {
  id: "codex",
  name: "Codex",
  command: "codex",
  installed: true,
  authenticated: true,
  models: [{ id: "gpt-5", label: "GPT-5", isDefault: true }],
};

describe("competitor colors", () => {
  it("gives a new competitor the first color nobody in the lineup is using", () => {
    let lineup: Competitor[] = [];
    for (let index = 0; index < 3; index += 1) lineup = [...lineup, makeCompetitor(provider, lineup)];
    const [first, second, third] = lineup;

    lineup = lineup.filter((competitor) => competitor.id !== second.id);
    const added = makeCompetitor(provider, lineup);

    expect(added.color).toBe(second.color);
    expect(new Set([first.color, third.color, added.color]).size).toBe(3);
  });

  it("falls back to cycling once every color is taken", () => {
    let lineup: Competitor[] = [];
    for (let index = 0; index < 6; index += 1) lineup = [...lineup, makeCompetitor(provider, lineup)];
    expect(new Set(lineup.map((competitor) => competitor.color)).size).toBe(6);
    expect(nextColor(lineup)).toBe(lineup[0].color);
  });
});
