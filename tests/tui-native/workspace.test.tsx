/** @jsxImportSource @opentui/react */
import { afterEach, describe, expect, test } from "bun:test";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { createRoot } from "@opentui/react";
import { act } from "react";

import type { HarnessAdapter } from "../../src/server/adapters/types.js";
import type {
  BenchmarkRequest,
  HarnessId,
  ProviderInfo,
  RunResult,
  SummaryRow,
} from "../../src/shared/types.js";
import type { BenchmarkRunner, ProbedAdapter, TerminalModeResult } from "../../src/terminal.js";
import { TpsRacerApp } from "../../src/tui/app.js";

interface NativeApp {
  setup: TestRendererSetup;
  destroy: () => void;
}

interface Fixture {
  adapters: HarnessAdapter[];
  probes: ProbedAdapter[];
}

let activeApp: NativeApp | undefined;

function provider(
  id: HarnessId,
  name: string,
  modelId: string,
  modelLabel: string,
  extraModels: ProviderInfo["models"] = [],
): ProviderInfo {
  return {
    id,
    name,
    command: name.toLowerCase(),
    installed: true,
    authenticated: true,
    defaultModel: modelId,
    models: [{ id: modelId, label: modelLabel, isDefault: true }, ...extraModels],
  };
}

function fixture(sixLaneCatalog = false): Fixture {
  const providers = [
    provider(
      "codex",
      "Codex",
      "gpt-5.5",
      "GPT-5.5",
      sixLaneCatalog ? [{ id: "gpt-5.5-mini", label: "GPT-5.5 Mini" }] : [],
    ),
    provider(
      "cursor",
      "Cursor",
      "composer",
      "Composer",
      sixLaneCatalog ? [{ id: "composer-fast", label: "Composer Fast" }] : [],
    ),
    provider(
      "grok",
      "Grok",
      "grok-code",
      "Grok Code",
      sixLaneCatalog ? [{ id: "grok-max", label: "Grok Max" }] : [],
    ),
  ];
  const adapters = providers.map<HarnessAdapter>((info) => ({
    id: info.id,
    name: info.name,
    command: info.command,
    async probe() {
      return info;
    },
    async run() {
      return {};
    },
  }));
  return {
    adapters,
    probes: providers.map((info, index) => ({ adapter: adapters[index], provider: info })),
  };
}

async function renderWorkspace({
  width = 150,
  height = 34,
  runner = async () => {},
  data = fixture(),
  onExit = () => {},
  onShutdownReady,
}: {
  width?: number;
  height?: number;
  runner?: BenchmarkRunner;
  data?: Fixture;
  onExit?: (result: TerminalModeResult) => void;
  onShutdownReady?: (shutdown: () => Promise<void>) => void;
} = {}): Promise<NativeApp> {
  const setup = await createTestRenderer({ width, height, enableMouseMovement: false });
  const root = createRoot(setup.renderer);
  const reactEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

  act(() => {
    root.render(
      <TpsRacerApp
        adapters={data.adapters}
        runBenchmark={runner}
        probeAdapters={async () => data.probes}
        onExit={onExit}
        onShutdownReady={onShutdownReady}
      />,
    );
  });
  // OpenTUI's test renderer drives its own frame loop. Leaving React's browser
  // act flag enabled would both warn and hold async probe updates until the
  // renderer wait has already timed out.
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = false;

  const app: NativeApp = {
    setup,
    destroy() {
      reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
      act(() => root.unmount());
      setup.renderer.destroy();
      reactEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    },
  };
  activeApp = app;
  return app;
}

async function settledFrame(
  setup: TestRendererSetup,
  predicate: (frame: string) => boolean,
): Promise<string> {
  return setup.waitForFrame(predicate, { maxPasses: 80 });
}

async function interact(setup: TestRendererSetup, action: () => void | Promise<void>): Promise<void> {
  await action();
  await setup.flush();
}

function lineWith(frame: string, ...needles: string[]): string | undefined {
  return frame.split("\n").find((line) => needles.every((needle) => line.includes(needle)));
}

async function clickText(setup: TestRendererSetup, needle: string): Promise<void> {
  const lines = setup.captureCharFrame().split("\n");
  const y = lines.findIndex((line) => line.includes(needle));
  if (y < 0) throw new Error(`Could not click missing text: ${needle}`);
  const x = lines[y].indexOf(needle) + 1;
  await interact(setup, () => setup.mockMouse.click(x, y));
}

function completedRunner(): BenchmarkRunner {
  return async (request, _adapters, _signal, emit) => {
    const results: RunResult[] = request.competitors.map((competitor, index) => ({
      competitorId: competitor.id,
      workload: "prose",
      sample: 1,
      warmup: false,
      output: `finished ${competitor.label}`,
      valid: true,
      metrics: {
        harnessPrepMs: 80 + index,
        promptToFirstOutputMs: 100 + index * 10,
        coldStartToFirstOutputMs: 180 + index * 10,
        visibleStreamMs: 700 + index * 10,
        promptToFinishMs: 1_000 + index * 100,
        visibleTokens: 300,
        visibleTokensPerSecond: 500 - index * 20,
        streamChunkCount: 10 + index,
      },
    }));
    const summary: SummaryRow[] = request.competitors.map((competitor, index) => ({
      competitor,
      measuredRuns: 1,
      validRuns: 1,
      anomalousRuns: 0,
      disqualified: false,
      promptToFirstOutputMs: 100 + index * 10,
      coldStartToFirstOutputMs: 180 + index * 10,
      promptToFinishMs: 1_000 + index * 100,
      visibleTokensPerSecond: 500 - index * 20,
      finishRank: index + 1,
      crowns: index === 0 ? ["finish", "firstOutput", "coldStart", "visibleSpeed"] : [],
    }));

    emit({ type: "benchmark.started", benchmarkId: "completed-native-test", totalRuns: results.length });
    await Bun.sleep(25);
    emit({ type: "benchmark.complete", results, summary });
  };
}

afterEach(() => {
  activeApp?.destroy();
  activeApp = undefined;
});

describe("native OpenTUI workspace", () => {
  test("renders a persistent roster, starting grid, and action dock in one frame", async () => {
    const { setup } = await renderWorkspace();
    const frame = await settledFrame(setup, (next) =>
      next.includes("STARTING GRID") &&
      next.includes("Codex / GPT-5.5") &&
      next.includes("Cursor / Composer") &&
      next.includes("Grok / Grok Code") &&
      next.includes("grid looks right.")
    );

    expect(frame).toContain("TPS RACER");
    expect(frame).toContain("RACERS");
    expect(frame).toContain("Choose racers and run");
    expect(frame).toContain("grid looks right.");
    expect(frame).toContain("ENTER  start race");
    expect(frame).toContain("ctrl+p  commands");
  });

  test("opens native Ctrl-P search and removes its placeholder as soon as text is entered", async () => {
    const { setup } = await renderWorkspace();
    await settledFrame(setup, (frame) => frame.includes("Codex / GPT-5.5"));

    await interact(setup, () => setup.mockInput.pressKey("p", { ctrl: true }));
    let frame = await settledFrame(setup, (next) =>
      next.includes("Commands") && next.includes("Search actions…")
    );
    expect(frame).toContain("Search actions…");

    await interact(setup, () => setup.mockInput.typeText("rescan", 0));
    frame = await settledFrame(setup, (next) => next.includes("rescan"));
    expect(frame).not.toContain("Search actions…");
    expect(frame).toContain("Rescan local CLIs");
  });

  test("starts on Enter and keeps every live lane visible at once", async () => {
    let request: BenchmarkRequest | undefined;
    const runner: BenchmarkRunner = async (nextRequest, _adapters, signal, emit) => {
      request = nextRequest;
      emit({ type: "benchmark.started", benchmarkId: "native-test", totalRuns: nextRequest.competitors.length });
      nextRequest.competitors.forEach((competitor, index) => {
        emit({
          type: "run.status",
          competitorId: competitor.id,
          workload: "prose",
          sample: 1,
          warmup: false,
          status: "running",
        });
        emit({
          type: "run.delta",
          competitorId: competitor.id,
          workload: "prose",
          sample: 1,
          text: `LIVE OUTPUT ${index + 1}`,
          elapsedMs: 100 + index,
          liveVisibleTokensPerSecond: 40 + index,
        });
      });
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    };
    const { setup } = await renderWorkspace({ runner });
    await settledFrame(setup, (frame) => frame.includes("Grok / Grok Code"));

    await interact(setup, async () => {
      setup.mockInput.pressEnter();
      await Bun.sleep(25);
    });
    const frame = await settledFrame(setup, (next) =>
      next.includes("LIVE WORKSPACE") &&
      next.includes("LIVE OUTPUT 1") &&
      next.includes("LIVE OUTPUT 2") &&
      next.includes("LIVE OUTPUT 3")
    );

    expect(request?.competitors).toHaveLength(3);
    expect(frame).toContain("Codex / GPT-5.5");
    expect(frame).toContain("Cursor / Composer");
    expect(frame).toContain("Grok / Grok Code");
    expect(
      lineWith(frame, "Codex / GPT-5.5", "Cursor / Composer", "Grok / Grok Code")?.match(/● LIVE/g),
    ).toHaveLength(3);
    expect(frame).toContain("0/3 heats");
  });

  test("reflows equal lane cells when the terminal moves between wide and narrow sizes", async () => {
    const { setup } = await renderWorkspace({ width: 150, height: 34 });
    let frame = await settledFrame(setup, (next) =>
      Boolean(lineWith(next, "Codex / GPT-5.5", "Cursor / Composer", "Grok / Grok Code"))
    );
    const wideLine = lineWith(frame, "Codex / GPT-5.5", "Cursor / Composer", "Grok / Grok Code");
    expect(wideLine).toBeDefined();
    const firstGap = wideLine!.indexOf("Cursor / Composer") - wideLine!.indexOf("Codex / GPT-5.5");
    const secondGap = wideLine!.indexOf("Grok / Grok Code") - wideLine!.indexOf("Cursor / Composer");
    expect(Math.abs(firstGap - secondGap)).toBeLessThanOrEqual(1);

    await interact(setup, () => setup.resize(76, 34));
    frame = await settledFrame(setup, (next) =>
      Boolean(lineWith(next, "Codex / GPT-5.5", "Cursor / Composer")) && next.includes("Grok / Grok Code")
    );
    const narrowRows = frame.split("\n");
    const firstRow = narrowRows.findIndex((line) =>
      line.includes("Codex / GPT-5.5") && line.includes("Cursor / Composer")
    );
    const secondRow = narrowRows.findIndex((line) => line.includes("Grok / Grok Code"));
    const narrowLine = narrowRows[firstRow];
    const narrowGap = narrowLine.indexOf("Cursor / Composer") - narrowLine.indexOf("Codex / GPT-5.5");

    expect(firstRow).toBeGreaterThanOrEqual(0);
    expect(secondRow).toBeGreaterThan(firstRow);
    expect(narrowGap).toBeGreaterThanOrEqual(35);
    expect(narrowGap).toBeLessThanOrEqual(39);
  });

  test("keeps the roster dismissed after a narrow resize until it is explicitly opened", async () => {
    const { setup } = await renderWorkspace();
    await settledFrame(setup, (frame) => frame.includes("RACERS") && frame.includes("STARTING GRID"));

    await interact(setup, () => setup.resize(76, 34));
    let frame = await settledFrame(setup, (next) =>
      next.includes("STARTING GRID") && next.includes("Codex / GPT-5.5") && !next.includes("RACERS")
    );
    expect(frame).not.toContain("RACERS");

    await interact(setup, () => setup.mockInput.pressArrow("down"));
    frame = setup.captureCharFrame();
    expect(frame).not.toContain("RACERS");

    await clickText(setup, "ctrl+p  commands");
    await settledFrame(setup, (next) => next.includes("Commands") && next.includes("Edit starting grid"));
    await clickText(setup, "Edit starting grid");
    frame = await settledFrame(setup, (next) => next.includes("RACERS") && next.includes("3/6"));
    expect(frame).toContain("local model speed lab");
  });

  test("does not swallow Ctrl-C while the command palette is open", async () => {
    const exits: TerminalModeResult[] = [];
    const { setup } = await renderWorkspace({ onExit: (result) => exits.push(result) });
    await settledFrame(setup, (frame) => frame.includes("Codex / GPT-5.5"));

    await interact(setup, () => setup.mockInput.pressKey("p", { ctrl: true }));
    await settledFrame(setup, (frame) => frame.includes("Commands") && frame.includes("Search actions…"));

    await interact(setup, () => setup.mockInput.pressKey("c", { ctrl: true }));
    const frame = await settledFrame(setup, (next) => !next.includes("Search actions…"));

    expect(exits).toEqual(["cancelled"]);
    expect(frame).not.toContain("Commands");
  });

  test("waits for active runner cleanup during shutdown", async () => {
    let shutdown: (() => Promise<void>) | undefined;
    let cleaned = false;
    const runner: BenchmarkRunner = async (_request, _adapters, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await Bun.sleep(20);
      cleaned = true;
    };
    const { setup } = await renderWorkspace({
      runner,
      onShutdownReady: (next) => {
        shutdown = next;
      },
    });
    await settledFrame(setup, (frame) => frame.includes("3/6") && frame.includes("grid looks right."));

    await interact(setup, async () => {
      setup.mockInput.pressEnter();
      await Bun.sleep(10);
    });
    await settledFrame(setup, (frame) => frame.includes("LIVE WORKSPACE"));
    expect(shutdown).toBeDefined();

    await shutdown!();
    expect(cleaned).toBe(true);
  });

  test("retains pending runner cleanup after cancel until shutdown", async () => {
    let shutdown: (() => Promise<void>) | undefined;
    let cleaned = false;
    const runner: BenchmarkRunner = async (_request, _adapters, signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await Bun.sleep(20);
      cleaned = true;
    };
    const { setup } = await renderWorkspace({
      runner,
      onShutdownReady: (next) => {
        shutdown = next;
      },
    });
    await settledFrame(setup, (frame) => frame.includes("3/6") && frame.includes("grid looks right."));

    await interact(setup, async () => {
      setup.mockInput.pressEnter();
      await Bun.sleep(10);
    });
    await settledFrame(setup, (frame) => frame.includes("LIVE WORKSPACE"));
    setup.mockInput.pressKey("c", { ctrl: true });
    await shutdown!();

    expect(cleaned).toBe(true);
  });

  test("uses Space to toggle the focused racer", async () => {
    const { setup } = await renderWorkspace({ data: fixture(true) });
    await settledFrame(setup, (frame) => frame.includes("RACERS") && frame.includes("3/6"));

    await interact(setup, async () => {
      setup.mockInput.pressArrow("down");
      await Bun.sleep(10);
      setup.mockInput.pressKey(" ");
      await Bun.sleep(10);
    });
    let frame = await settledFrame(setup, (next) => next.includes("4/6"));
    expect(lineWith(frame, "Codex / GPT-5.5 Mini", "✓")).toBeDefined();

    await interact(setup, async () => {
      setup.mockInput.pressKey(" ");
      await Bun.sleep(10);
    });
    frame = await settledFrame(setup, (next) => next.includes("3/6"));
    expect(lineWith(frame, "Codex / GPT-5.5 Mini", "✓")).toBeUndefined();
  });

  test("includes an immediately selected racer when Space is followed by Enter", async () => {
    let request: BenchmarkRequest | undefined;
    const runner: BenchmarkRunner = async (next) => {
      request = next;
    };
    const { setup } = await renderWorkspace({ data: fixture(true), runner });
    await settledFrame(setup, (frame) => frame.includes("RACERS") && frame.includes("3/6"));

    await interact(setup, async () => {
      setup.mockInput.pressArrow("down");
      await Bun.sleep(10);
      setup.mockInput.pressKey(" ");
      setup.mockInput.pressEnter();
      await Bun.sleep(25);
    });

    expect(request?.competitors).toHaveLength(4);
    expect(request?.competitors.some((competitor) => competitor.model === "gpt-5.5-mini")).toBe(true);
  });

  test("applies an immediate mode change and starts outside roster focus", async () => {
    let request: BenchmarkRequest | undefined;
    const runner: BenchmarkRunner = async (next) => {
      request = next;
    };
    const { setup } = await renderWorkspace({ runner });
    await settledFrame(setup, (frame) => frame.includes("RACERS") && frame.includes("3/6"));

    await interact(setup, async () => {
      setup.mockInput.pressKey("m");
      setup.mockInput.pressTab();
      setup.mockInput.pressEnter();
      await Bun.sleep(25);
    });

    expect(request?.mode).toBe("sequential");
    expect(request?.competitors).toHaveLength(3);
  });

  test("scrolls a narrow six-racer leaderboard to the last keyboard-selected racer", async () => {
    const { setup } = await renderWorkspace({
      width: 76,
      height: 24,
      data: fixture(true),
      runner: completedRunner(),
    });
    await settledFrame(setup, (frame) => frame.includes("RACERS") && frame.includes("3/6"));

    await clickText(setup, "Codex / GPT-5.5 Mini");
    await settledFrame(setup, (frame) => frame.includes("4/6"));
    await clickText(setup, "Cursor / Composer Fast");
    await settledFrame(setup, (frame) => frame.includes("5/6"));
    await interact(setup, () => setup.mockMouse.scroll(10, 14, "down"));
    await interact(setup, () => setup.mockMouse.scroll(10, 14, "down"));
    await settledFrame(setup, (frame) => frame.includes("Grok / Grok Max"));
    await clickText(setup, "Grok / Grok Max");
    await settledFrame(setup, (frame) => frame.includes("6/6"));

    await interact(setup, async () => {
      setup.mockInput.pressEnter();
      await Bun.sleep(25);
    });
    await settledFrame(setup, (frame) => Boolean(lineWith(frame, "P1", "Codex / GPT-5.5")));

    for (let index = 0; index < 5; index += 1) {
      await interact(setup, async () => {
        setup.mockInput.pressArrow("down");
        await Bun.sleep(10);
      });
    }
    const frame = await settledFrame(setup, (next) =>
      Boolean(lineWith(next, "P6", "Grok / Grok Max")) &&
      next.split("\n").some((line) => {
        const index = line.indexOf("Grok / Grok Max");
        return index >= 0 && index < 32;
      })
    );

    expect(lineWith(frame, "P6", "Grok / Grok Max")).toBeDefined();
    expect(frame.split("\n").some((line) => {
      const index = line.indexOf("Grok / Grok Max");
      return index >= 0 && index < 32;
    })).toBe(true);
  });
});
