import { describe, expect, it } from "vitest";
import { defineAdapter } from "../src/server/adapters/types.js";

describe("adapter contract", () => {
  it("assembles provider info from canonical adapter metadata", async () => {
    const adapter = defineAdapter(
      { id: "codex", name: "Codex", command: "codex" },
      {
        async probe() {
          return {
            installed: true,
            authenticated: true,
            models: [],
            ...({ id: "wrong", name: "Wrong", command: "wrong" } as object),
          };
        },
        async run() {
          return {};
        },
      },
    );

    expect(await adapter.probe()).toEqual({
      id: "codex",
      name: "Codex",
      command: "codex",
      installed: true,
      authenticated: true,
      models: [],
    });
  });
});
