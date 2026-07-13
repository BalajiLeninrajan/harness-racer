import { Box, Text } from "ink";
import React from "react";
import type { Competitor, RunMode, SamplePreset } from "../../shared/types.js";
import { ACCENT, BLUE, FOCUS_BACKGROUND, MUTED, YELLOW } from "../theme.js";
import { Footer, Header } from "./chrome.js";

interface SettingOptionProps {
  active: boolean;
  selected: boolean;
  width: number;
  label: string;
  detail: string;
  showDetail?: boolean;
}

function SettingOption({ active, selected, width, label, detail, showDetail = true }: SettingOptionProps) {
  return (
    <Box
      width={width}
      height={showDetail ? 2 : 1}
      paddingX={1}
      flexDirection="column"
      overflow="hidden"
      backgroundColor={selected ? FOCUS_BACKGROUND : active ? "#252536" : undefined}
    >
      <Text bold={active || selected} color={selected ? ACCENT : active ? BLUE : undefined}>{active ? "› " : "  "}{selected ? "● " : "○ "}{label}</Text>
      {showDetail && <Text dimColor wrap="truncate-end">{detail}</Text>}
    </Box>
  );
}

export interface ConfigureViewProps {
  competitors: Competitor[];
  cursor: number;
  mode: RunMode;
  preset: SamplePreset;
  columns: number;
  rows?: number;
  notice?: string;
}

export function ConfigureView({ competitors, cursor, mode, preset, columns, rows = 24, notice }: ConfigureViewProps) {
  const compact = columns < 76 || rows < 19;
  const panelPaddingX = compact ? 1 : 2;
  const settingsWidth = Math.max(28, columns - 4 - panelPaddingX * 2);
  const labelWidth = 14;
  const runWidth = compact
    ? Math.max(10, Math.floor((settingsWidth - 1) / 2))
    : Math.max(20, Math.min(30, Math.floor((settingsWidth - labelWidth - 2) / 2)));
  const presetWidth = compact
    ? Math.max(8, Math.floor((settingsWidth - 2) / 3))
    : Math.max(17, Math.min(22, Math.floor((settingsWidth - labelWidth - 3) / 3)));
  return (
    <Box flexDirection="column" paddingY={compact ? 0 : 1} paddingX={1} width="100%">
      <Header phase="configure" />
      <Box justifyContent="space-between">
        <Text bold>Set the starting grid.</Text>
        <Text dimColor>e edit lineup</Text>
      </Box>
      <Box marginTop={compact ? 0 : 1} height={1} overflow="hidden">
        <Text wrap="truncate-end">
          {competitors.map((competitor, index) => (
            <React.Fragment key={competitor.id}>
              {index > 0 ? "  " : ""}<Text color={competitor.color}>● </Text><Text bold>{competitor.label}</Text>{!compact && <Text dimColor> · {competitor.harness}</Text>}
            </React.Fragment>
          ))}
        </Text>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderColor={MUTED} paddingX={panelPaddingX} paddingY={compact ? 0 : 1} marginTop={1}>
        {compact ? (
          <>
            <Text bold color={BLUE}>RUN ORDER</Text>
            <Box height={1} columnGap={1}>
              <SettingOption active={cursor === 0} selected={mode === "parallel"} width={runWidth} label="Parallel" detail="Start together" showDetail={false} />
              <SettingOption active={cursor === 1} selected={mode === "sequential"} width={runWidth} label="Sequential" detail="One at a time" showDetail={false} />
            </Box>
            <Box marginTop={1}><Text bold color={BLUE}>SAMPLES</Text></Box>
            <Box height={1} columnGap={1}>
              <SettingOption active={cursor === 2} selected={preset === "quick"} width={presetWidth} label="Quick" detail="2 measured" showDetail={false} />
              <SettingOption active={cursor === 3} selected={preset === "standard"} width={presetWidth} label="Standard" detail="2 warmup · 6 measured" showDetail={false} />
              <SettingOption active={cursor === 4} selected={preset === "thorough"} width={presetWidth} label="Thorough" detail="2 warmup · 10 measured" showDetail={false} />
            </Box>
          </>
        ) : (
          <>
            <Box height={2} columnGap={1} alignItems="flex-start">
              <Box width={labelWidth}><Text bold color={BLUE}>RUN ORDER</Text></Box>
              <SettingOption active={cursor === 0} selected={mode === "parallel"} width={runWidth} label="Parallel" detail="Start together" />
              <SettingOption active={cursor === 1} selected={mode === "sequential"} width={runWidth} label="Sequential" detail="One at a time" />
            </Box>

            <Box height={2} columnGap={1} marginTop={1} alignItems="flex-start">
              <Box width={labelWidth}><Text bold color={BLUE}>SAMPLES</Text></Box>
              <SettingOption active={cursor === 2} selected={preset === "quick"} width={presetWidth} label="Quick" detail="2 measured" />
              <SettingOption active={cursor === 3} selected={preset === "standard"} width={presetWidth} label="Standard" detail="2 warmup · 6 measured" />
              <SettingOption active={cursor === 4} selected={preset === "thorough"} width={presetWidth} label="Thorough" detail="2 warmup · 10 measured" />
            </Box>
          </>
        )}

        <Box marginTop={1} height={1} paddingX={1} justifyContent="space-between" backgroundColor={cursor === 5 ? FOCUS_BACKGROUND : undefined}>
          <Text bold color={cursor === 5 ? ACCENT : undefined}>{cursor === 5 ? "› " : "  "}Start race</Text>
          <Text dimColor>enter ↵</Text>
        </Box>
      </Box>
      {notice && <Text color={YELLOW}>{notice}</Text>}
      <Footer>{compact
        ? "h/j/k/l move  space select  enter start  e edit  q quit"
        : "h/j/k/l move  space select  enter start race  e/esc edit racers  q quit"}</Footer>
    </Box>
  );
}
