import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveTuiEntry, supportsTerminalTui } from "../../src/tui/index.js";

describe("native TUI launcher", () => {
  it("resolves the Bun source entry during development and the sibling bundle after build", () => {
    const root = process.cwd();
    expect(resolveTuiEntry(pathToFileURL(resolve(root, "src/tui/index.ts")).href)).toBe(
      resolve(root, "src/tui-entry.ts"),
    );
    expect(resolveTuiEntry(pathToFileURL(resolve(root, "dist/cli.js")).href)).toBe(
      resolve(root, "dist/tui.js"),
    );
  });

  it("only enables the native renderer for an interactive, capable terminal", () => {
    const input = {
      isTTY: true,
      setRawMode() {},
      on() {},
    } as unknown as Parameters<typeof supportsTerminalTui>[0];
    const output = {
      isTTY: true,
      write() {},
      on() {},
      off() {},
    } as Parameters<typeof supportsTerminalTui>[1];

    expect(supportsTerminalTui(input, output, "xterm-256color")).toBe(true);
    expect(supportsTerminalTui(input, output, "dumb")).toBe(false);
    expect(supportsTerminalTui({ ...input, isTTY: false }, output, "xterm-256color")).toBe(false);
  });
});
