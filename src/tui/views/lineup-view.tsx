import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { MAX_RACERS } from "../constants.js";
import type { RacerOption } from "../model.js";
import { FOCUS_BACKGROUND, TUI_COLORS, YELLOW } from "../theme.js";
import { Footer, Header } from "./chrome.js";

export interface LineupViewProps {
  options: RacerOption[];
  selected: string[];
  cursor: number;
  columns?: number;
  rows?: number;
  notice?: string;
}

export function LineupView({ options, selected, cursor, columns = 80, rows = 24, notice }: LineupViewProps) {
  const optionMap = new Map(options.map((option) => [option.key, option]));
  const selectedOptions = selected.map((key) => optionMap.get(key)).filter((option): option is RacerOption => option !== undefined);
  const addIndex = selected.length < MAX_RACERS ? selected.length : -1;
  const continueIndex = selected.length + (addIndex >= 0 ? 1 : 0);
  const spaciousRows = rows >= selectedOptions.length * 2 + 12;
  const horizontalPadding = columns < 64 ? 1 : 2;

  const item = (index: number, content: ReactNode, detail?: ReactNode, color?: string, spacious = false) => {
    const active = cursor === index;
    return (
      <Box
        key={index}
        height={spacious && spaciousRows ? 2 : 1}
        flexDirection="column"
        justifyContent="flex-start"
      >
        <Box height={1} paddingX={horizontalPadding} justifyContent="space-between" backgroundColor={active ? FOCUS_BACKGROUND : undefined}>
          <Box minWidth={0} flexGrow={1}>
            <Text bold={active} wrap="truncate-end">{active ? "› " : "  "}{color && <Text color={color}>● </Text>}{content}</Text>
          </Box>
          {detail && <Box marginLeft={1}><Text dimColor>{detail}</Text></Box>}
        </Box>
      </Box>
    );
  };

  return (
    <Box flexDirection="column" paddingY={spaciousRows ? 1 : 0} paddingX={horizontalPadding} width="100%">
      <Header phase="lineup" />
      <Box justifyContent="space-between">
        <Text bold>Build your lineup.</Text>
        <Text dimColor>{selected.length} / {MAX_RACERS} racers</Text>
      </Box>
      <Text dimColor>Enter changes a racer; `a` adds one directly.</Text>

      <Box flexDirection="column" marginTop={spaciousRows ? 1 : 0}>
        <Box flexDirection="column">
          {selectedOptions.map((option, index) => item(
            index,
            <><Text dimColor>{String(index + 1).padStart(2, "0")} </Text>{option.model.label}</>,
            <>via {option.provider.name}</>,
            TUI_COLORS[index],
            true,
          ))}
        </Box>
        <Box flexDirection="column" marginTop={spaciousRows ? 1 : 0}>
          {addIndex >= 0 && item(addIndex, <>＋ Add racer</>, <>a</>)}
          {item(continueIndex, <>Continue to starting grid →</>, <>c</>)}
        </Box>
      </Box>

      {notice && <Text color={YELLOW}>{notice}</Text>}
      <Footer>{columns < 72
        ? "j/k move  enter change  a add  d remove  c continue"
        : "j/k move  enter change  a add  d remove  c continue  q quit"}</Footer>
    </Box>
  );
}
