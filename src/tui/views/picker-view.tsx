import { Box, Text } from "ink";
import type { ProviderInfo } from "../../shared/types.js";
import type { RacerOption } from "../model.js";
import { ACCENT, MUTED, YELLOW } from "../theme.js";
import type { PickerState } from "../types.js";
import { Footer, Header } from "./chrome.js";

export interface PickerViewProps {
  providers: ProviderInfo[];
  options: RacerOption[];
  filtered: RacerOption[];
  selected: string[];
  state: PickerState;
  columns: number;
  rows: number;
}

export function PickerView({ providers, options, filtered, selected, state, columns, rows }: PickerViewProps) {
  const activeProvider = providers[state.providerCursor];
  const narrow = columns < 64;
  const compactHeight = rows < 20;
  const paneGap = narrow ? 1 : 2;
  const panePaddingX = columns < 72 ? 1 : 2;
  const panePaddingY = compactHeight ? 0 : 1;
  const providerWidth = Math.max(15, Math.min(25, Math.floor(columns * (narrow ? 0.32 : 0.25))));
  const modelWidth = Math.max(20, columns - providerWidth - paneGap - 2);
  const paneHeight = Math.max(6, rows - 8);
  const visibleCount = Math.max(1, paneHeight - (panePaddingY * 2 + 5));
  const start = Math.max(0, Math.min(state.modelCursor - Math.floor(visibleCount / 2), filtered.length - visibleCount));
  const visible = filtered.slice(start, start + visibleCount);
  const providerVisibleCount = Math.max(1, paneHeight - (panePaddingY * 2 + 3 + (compactHeight ? 0 : 1)));
  const providerStart = Math.max(0, Math.min(state.providerCursor - Math.floor(providerVisibleCount / 2), providers.length - providerVisibleCount));
  const visibleProviders = providers.slice(providerStart, providerStart + providerVisibleCount);
  const labelWidth = Math.max(12, Math.min(34, Math.floor(modelWidth * 0.45)));

  return (
    <Box flexDirection="column" padding={1} width="100%">
      <Header phase="picker" />
      <Box justifyContent="space-between">
        <Text bold>{state.slot < selected.length ? `Change racer ${state.slot + 1}` : "Add a racer"}</Text>
        <Text dimColor>{state.focus === "providers" ? "harnesses" : state.searching ? "search" : "models"}</Text>
      </Box>
      <Box columnGap={paneGap} marginTop={1} height={paneHeight}>
        <Box
          width={providerWidth}
          height={paneHeight}
          borderStyle={state.focus === "providers" ? "double" : "round"}
          borderColor={MUTED}
          paddingX={panePaddingX}
          paddingY={panePaddingY}
          flexDirection="column"
          overflow="hidden"
        >
          <Box justifyContent="space-between" marginBottom={compactHeight ? 0 : 1}>
            <Text bold color={state.focus === "providers" ? ACCENT : undefined}>HARNESS</Text>
            {providers.length > providerVisibleCount && <Text dimColor>{providerStart + 1}–{Math.min(providerStart + providerVisibleCount, providers.length)}</Text>}
          </Box>
          <Box flexDirection="column">
            {visibleProviders.map((provider, visibleIndex) => {
              const index = providerStart + visibleIndex;
              const active = index === state.providerCursor;
              const count = options.filter((option) => option.provider.id === provider.id).length;
              return (
                <Box key={provider.id} height={1} overflow="hidden" justifyContent="space-between" paddingX={1}>
                  <Text bold={active} color={active ? ACCENT : undefined} wrap="truncate-end">{active ? "› " : "  "}{provider.name}</Text>
                  {columns >= 52 && <Text dimColor>{count}</Text>}
                </Box>
              );
            })}
          </Box>
        </Box>

        <Box
          width={modelWidth}
          height={paneHeight}
          borderStyle={state.focus === "models" ? "double" : "round"}
          borderColor={MUTED}
          paddingX={panePaddingX}
          paddingY={panePaddingY}
          flexDirection="column"
          overflow="hidden"
        >
          <Box justifyContent="space-between" marginBottom={compactHeight ? 0 : 1}>
            <Text color={state.searching ? ACCENT : undefined}>/ {state.query || "search models"}{state.searching ? "▌" : ""}</Text>
            <Text dimColor>{filtered.length ? `${start + 1}–${Math.min(start + visibleCount, filtered.length)} / ${filtered.length}` : "0 models"}</Text>
          </Box>
          <Box justifyContent="space-between">
            <Text bold>{activeProvider?.name ?? "Models"}</Text>
            <Text dimColor>{state.query ? `filter: ${state.query}` : "default first"}</Text>
          </Box>
          {visible.map((option, visibleIndex) => {
            const index = start + visibleIndex;
            const active = index === state.modelCursor;
            return (
              <Box key={option.key} height={1} overflow="hidden" paddingX={1}>
                <Box width={3}><Text color={active ? ACCENT : undefined}>{active ? "›" : " "}</Text></Box>
                <Box width={labelWidth}><Text bold={active} color={active ? ACCENT : undefined} wrap="truncate-end">{option.model.label}</Text></Box>
                <Box flexGrow={1}><Text dimColor wrap="truncate-end">{option.model.id}</Text></Box>
                {option.model.isDefault && <Text color={YELLOW}> DEFAULT</Text>}
              </Box>
            );
          })}
          {!filtered.length && <Box flexGrow={1} alignItems="center" justifyContent="center"><Text dimColor>No matching models</Text></Box>}
        </Box>
      </Box>
      <Footer>{state.searching
        ? columns < 72
          ? "type filter  ctrl+n/p browse  enter choose  esc done"
          : "type filter  ctrl+n/p browse  ctrl+u clear  enter choose  esc normal mode"
        : columns < 72
          ? "h/l tier  j/k browse  / search  enter choose  esc back"
          : "h/l tier  j/k browse  / search  g/G first/last  enter choose  q/esc back"}</Footer>
    </Box>
  );
}
