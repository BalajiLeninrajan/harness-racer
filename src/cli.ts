const argv = process.argv.slice(2);
const args = new Set(argv);

function valueAfter(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function printHelp(): void {
  console.log(`harness-racer — race local coding-agent stacks

Usage:
  harness-racer                 Open the browser dashboard
  harness-racer --cli           Run the interactive terminal UI

Options:
  --cli, --tui              Use terminal mode
  --web                     Use the browser dashboard (default)
  --port <number>           Browser server port (default: 4317)
  --no-open                 Do not open the browser automatically
  --dev                     Use Vite middleware for browser development
  -h, --help                Show this help`);
}

async function main(): Promise<void> {
  if (args.has("--help") || args.has("-h")) {
    printHelp();
    return;
  }

  if (args.has("--cli") || args.has("--tui")) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("CLI mode needs an interactive terminal. Run it directly with `harness-racer --cli`.");
    }
    const { runTui } = await import("./tui/app.js");
    await runTui();
    return;
  }

  const portValue = valueAfter("--port");
  const port = portValue === undefined ? 4317 : Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${portValue ?? ""}`);
  }

  const { runWeb } = await import("./web.js");
  await runWeb({
    dev: args.has("--dev"),
    open: !args.has("--no-open"),
    port,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
