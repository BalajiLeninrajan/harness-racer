import { describe, expect, it } from "vitest";

import type { RunnableAdapter } from "../../src/terminal.js";
import { createStackOptions } from "../../src/tui/domain/competitors.js";
import { sanitizeTerminalOutput, sanitizeTerminalText } from "../../src/tui/sanitize.js";

describe("terminal text hardening", () => {
  it("removes ANSI, terminal strings, and control characters from labels", () => {
    expect(sanitizeTerminalText("\u001b[31mCodex\u001b[0m\u0007\u001b]0;owned\u0007", "Unknown"))
      .toBe("Codex");
  });

  it("sanitizes provider and model names before they enter the native renderer", () => {
    const runnable = [{
      adapter: { id: "codex", name: "Codex", command: "codex" },
      provider: {
        id: "codex",
        name: "\u001b[32mCodex\u001b[0m",
        command: "codex",
        installed: true,
        authenticated: true,
        models: [{ id: "fast", label: "Fast\u001b]52;c;bad\u0007" }],
      },
    }] as RunnableAdapter[];

    expect(createStackOptions(runnable)[0].label).toBe("Codex / Fast");
  });

  it("preserves newlines in streamed output while stripping control sequences", () => {
    expect(sanitizeTerminalOutput("one\n\u001b[31mtwo\u001b[0m\u0007")).toBe("one\ntwo");
  });
});
