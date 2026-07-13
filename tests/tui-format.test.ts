import { describe, expect, it } from "vitest";
import { formatProgressBar } from "../src/tui/format.js";

describe("terminal progress formatting", () => {
  it("renders empty, partial, and complete progress", () => {
    expect(formatProgressBar(0, 0, 5)).toBe("─────");
    expect(formatProgressBar(2, 4, 5)).toBe("━━━──");
    expect(formatProgressBar(4, 4, 5)).toBe("━━━━━");
  });

  it("clamps progress and normalizes width", () => {
    expect(formatProgressBar(-1, 4, 3.8)).toBe("───");
    expect(formatProgressBar(10, 4, 3.8)).toBe("━━━");
    expect(formatProgressBar(1, 1, -3)).toBe("");
  });
});
