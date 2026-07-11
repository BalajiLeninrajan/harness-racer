import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function runCli(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...args],
    { cwd: process.cwd() },
  );
  return stdout;
}

describe("CLI help", () => {
  it.each([["--help"], ["-h"], ["--cli", "--help"]])(
    "prints useful help for %s",
    async (...args) => {
      const output = await runCli(...args);
      expect(output).toContain("Usage: tps-racer [options]");
      expect(output).toContain("--cli");
      expect(output).toContain("Terminal workbench:");
      expect(output).toContain("Space           Select or remove a racer");
      expect(output).toContain("Ctrl-P          Open the command palette");
      expect(output).toContain("requires Bun");
      expect(output).not.toContain("j/k");
    },
  );
});
