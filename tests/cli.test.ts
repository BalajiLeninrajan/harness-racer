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
      expect(output).toContain("Terminal UI:");
      expect(output).toContain("Space          Choose a model");
      expect(output).toContain("Enter          Continue, start the race, or finish");
    },
  );
});
