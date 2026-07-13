import { Box, Text, render, useApp, useWindowSize } from "ink";
import type { ReactNode } from "react";
import { usePulse, useSpinner } from "./animations.js";
import { useTuiController } from "./use-tui-controller.js";
import {
  ConfigureView,
  Footer,
  Header,
  LineupView,
  LoadingView,
  PickerView,
  ResultsView,
  RunningView,
} from "./views/index.js";

function TuiRoot() {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const controller = useTuiController(columns, exit);
  const spinner = useSpinner(controller.phase === "loading" || controller.phase === "running");
  const pulse = usePulse(controller.phase === "running");
  const contentColumns = Math.max(1, Math.min(columns, 112));

  if (controller.phase === "running") {
    return (
      <RunningView
        competitors={controller.competitors}
        race={controller.race}
        spinner={spinner}
        columns={columns}
        rows={rows}
        cursor={controller.laneCursor}
        zoomed={controller.zoomed}
        pulse={pulse}
      />
    );
  }

  let view: ReactNode;
  if (controller.phase === "loading") {
    view = <LoadingView spinner={spinner} />;
  } else if (controller.phase === "error") {
    view = (
      <Box flexDirection="column" padding={1} width="100%">
        <Header phase="error" />
        <Text bold color="red">Could not start terminal mode.</Text>
        <Text>{controller.error}</Text>
        <Footer>enter/q quit</Footer>
      </Box>
    );
  } else if (controller.phase === "lineup") {
    view = (
      <LineupView
        options={controller.options}
        selected={controller.selected}
        cursor={controller.lineupCursor}
        columns={contentColumns}
        rows={rows}
        notice={controller.notice}
      />
    );
  } else if (controller.phase === "picker") {
    view = (
      <PickerView
        providers={controller.providers}
        options={controller.options}
        filtered={controller.filteredPickerOptions}
        selected={controller.selected}
        state={controller.picker}
        columns={contentColumns}
        rows={rows}
      />
    );
  } else if (controller.phase === "configure") {
    view = (
      <ConfigureView
        competitors={controller.competitors}
        cursor={controller.configCursor}
        mode={controller.mode}
        preset={controller.preset}
        columns={contentColumns}
        rows={rows}
        notice={controller.notice}
      />
    );
  } else {
    view = <ResultsView race={controller.race} columns={contentColumns} rows={rows} />;
  }

  return (
    <Box key={`${controller.phase}:${columns}x${rows}`} width={columns} height={rows} overflow="hidden" justifyContent="center">
      <Box width={contentColumns} height={rows} overflow="hidden">{view}</Box>
    </Box>
  );
}

export async function runTui(): Promise<void> {
  const instance = render(<TuiRoot />, {
    exitOnCtrlC: false,
    incrementalRendering: true,
    maxFps: 20,
  });
  await instance.waitUntilExit();
}
