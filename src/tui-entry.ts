import type { TerminalModeResult } from "./terminal.js";
import { runOpenTui } from "./tui/run.js";

const EXIT_CODES: Readonly<Record<TerminalModeResult, number>> = {
  completed: 0,
  declined: 2,
  unavailable: 3,
  cancelled: 130,
  failed: 1,
};

try {
  const result = await runOpenTui();
  // Native probes may still own timers or subprocess pipes while their
  // promises unwind. The renderer is already unmounted at this point, so exit
  // explicitly instead of leaving a restored-but-hung terminal process.
  process.exit(EXIT_CODES[result]);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
}
