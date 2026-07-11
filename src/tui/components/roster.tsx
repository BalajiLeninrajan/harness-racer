/** @jsxImportSource @opentui/react */
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";

import type { ProbedAdapter } from "../../terminal.js";
import type { BenchmarkSettings, StackOption } from "../domain/competitors.js";
import { palette } from "../palette.js";
import { sanitizeTerminalText } from "../sanitize.js";

export interface RosterProps {
  stacks: readonly StackOption[];
  unavailable: readonly ProbedAdapter[];
  selected: ReadonlySet<string>;
  cursor: number;
  focused: boolean;
  settings: BenchmarkSettings;
  loading?: boolean;
  onFocus: () => void;
  onCursor: (index: number) => void;
  onToggle: (value: string) => void;
  onCycleMode: () => void;
  onCyclePreset: () => void;
}

function unavailableLabel(item: ProbedAdapter): string {
  const name = item.provider?.name ?? item.adapter.name;
  const reason = item.error?.message ?? item.provider?.message ?? "unavailable";
  return `${sanitizeTerminalText(name, "Unknown", 36)} · ${sanitizeTerminalText(reason, "unavailable", 64)}`;
}

export function Roster({
  stacks,
  unavailable,
  selected,
  cursor,
  focused,
  settings,
  loading,
  onFocus,
  onCursor,
  onToggle,
  onCycleMode,
  onCyclePreset,
}: RosterProps) {
  const listRef = useRef<ScrollBoxRenderable>(null);

  useEffect(() => {
    listRef.current?.scrollChildIntoView(`roster-${cursor}`);
  }, [cursor]);

  return (
    <box
      width={31}
      height="100%"
      flexShrink={0}
      flexDirection="column"
      backgroundColor={palette.panel}
      border={["right"]}
      borderColor={palette.border}
      onMouseDown={onFocus}
    >
      <box height={4} flexShrink={0} paddingLeft={2} paddingTop={1} flexDirection="column">
        <text fg={palette.text} attributes={TextAttributes.BOLD}>TPS RACER</text>
        <text fg={palette.textMuted}>local model speed lab</text>
      </box>

      <box height={2} flexShrink={0} flexDirection="row" paddingLeft={2} alignItems="center">
        <text fg={palette.textMuted}>RACERS</text>
        <box flexGrow={1} />
        <text fg={selected.size ? palette.green : palette.textMuted}>{selected.size}/6 </text>
      </box>

      <scrollbox
        ref={listRef}
        focused={focused}
        flexGrow={1}
        minHeight={0}
        scrollY
        scrollbarOptions={{ visible: false }}
      >
        {loading ? (
          <box height={2} flexShrink={0} paddingLeft={2}>
            <text fg={palette.cyan}>●  discovering local CLIs…</text>
          </box>
        ) : null}

        {stacks.map((stack, index) => {
          const active = index === cursor;
          const checked = selected.has(stack.value);
          return (
            <box
              id={`roster-${index}`}
              key={stack.value}
              height={1}
              marginBottom={1}
              flexShrink={0}
              flexDirection="row"
              paddingLeft={1}
              paddingRight={1}
              alignItems="center"
              onMouseUp={() => {
                onFocus();
                onCursor(index);
                onToggle(stack.value);
              }}
            >
              <text fg={active ? palette.accent : palette.panel}>{active ? "▎" : " "}</text>
              <text fg={palette.green}>●</text>
              <box height={1} flexGrow={1} minWidth={0} overflow="hidden">
                <text
                  fg={active ? palette.text : palette.textMuted}
                  attributes={active ? TextAttributes.BOLD : 0}
                  wrapMode="none"
                >
                  {" "}{stack.label}
                </text>
              </box>
              <box width={2} flexShrink={0} justifyContent="flex-end">
                <text fg={checked ? palette.green : palette.textSubtle}>{checked ? "✓" : " "}</text>
              </box>
            </box>
          );
        })}

        {unavailable.length ? (
          <box flexDirection="column" flexShrink={0} paddingLeft={2} paddingTop={1}>
            <text fg={palette.textSubtle}>OFFLINE</text>
            {unavailable.map((item) => (
              <text key={item.adapter.id} fg={palette.textSubtle}>○ {unavailableLabel(item)}</text>
            ))}
          </box>
        ) : null}
      </scrollbox>

      <box flexShrink={0} flexDirection="column" padding={1} gap={1}>
        <box
          height={2}
          flexDirection="row"
          paddingLeft={1}
          paddingRight={1}
          alignItems="center"
          backgroundColor={palette.panelRaised}
          onMouseUp={onCycleMode}
        >
          <text fg={palette.textMuted}>MODE</text>
          <box flexGrow={1} />
          <text fg={palette.cyan}>{settings.mode}</text>
        </box>
        <box
          height={2}
          flexDirection="row"
          paddingLeft={1}
          paddingRight={1}
          alignItems="center"
          backgroundColor={palette.panelRaised}
          onMouseUp={onCyclePreset}
        >
          <text fg={palette.textMuted}>SAMPLES</text>
          <box flexGrow={1} />
          <text fg={palette.yellow}>{settings.samplePreset}</text>
        </box>
        <text fg={palette.textSubtle}>space select  ·  ctrl+p</text>
      </box>
    </box>
  );
}
