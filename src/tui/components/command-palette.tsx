/** @jsxImportSource @opentui/react */
import { RGBA, TextAttributes } from "@opentui/core";

import { palette } from "../palette.js";

export interface WorkspaceCommand {
  id: string;
  title: string;
  description?: string;
  shortcut?: string;
  category: "Race" | "Grid" | "View" | "Application";
  run: () => void;
}

export interface CommandPaletteProps {
  width: number;
  height: number;
  query: string;
  commands: readonly WorkspaceCommand[];
  selectedIndex: number;
  onQuery: (value: string) => void;
  onSelectedIndex: (index: number) => void;
  onRun: (command: WorkspaceCommand) => void;
  onClose: () => void;
}

export function filterCommands(
  commands: readonly WorkspaceCommand[],
  query: string,
): WorkspaceCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...commands];
  return commands.filter((command) =>
    `${command.title} ${command.description ?? ""} ${command.category}`.toLowerCase().includes(needle)
  );
}

export function CommandPalette({
  width,
  height,
  query,
  commands,
  selectedIndex,
  onQuery,
  onSelectedIndex,
  onRun,
  onClose,
}: CommandPaletteProps) {
  const filtered = filterCommands(commands, query);
  const panelWidth = Math.min(66, Math.max(34, width - 4));
  const listHeight = Math.min(Math.max(4, filtered.length * 2), Math.max(4, Math.floor(height / 2)));

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      zIndex={1000}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={Math.max(2, Math.floor(height / 5))}
      backgroundColor={RGBA.fromInts(0, 0, 0, 170)}
      onMouseUp={onClose}
    >
      <box
        width={panelWidth}
        flexDirection="column"
        backgroundColor={palette.panelRaised}
        paddingTop={1}
        paddingBottom={1}
        onMouseUp={(event) => event.stopPropagation()}
      >
        <box height={2} flexDirection="row" paddingLeft={2} paddingRight={2} alignItems="center">
          <text fg={palette.text} attributes={TextAttributes.BOLD}>Commands</text>
          <box flexGrow={1} />
          <text fg={palette.textSubtle}>esc</text>
        </box>
        <box height={3} marginLeft={1} marginRight={1} paddingLeft={1} backgroundColor={palette.element}>
          <input
            focused
            value={query}
            placeholder="Search actions…"
            onInput={onQuery}
            onSubmit={() => {
              const command = filtered[selectedIndex];
              if (command) onRun(command);
            }}
            style={{
              width: "100%",
              backgroundColor: palette.element,
              focusedBackgroundColor: palette.element,
              textColor: palette.text,
              focusedTextColor: palette.text,
              placeholderColor: palette.textSubtle,
            }}
          />
        </box>

        <scrollbox
          height={listHeight}
          minHeight={4}
          scrollY
          scrollbarOptions={{ visible: false }}
          paddingTop={1}
        >
          {filtered.length ? filtered.map((command, index) => {
            const active = index === selectedIndex;
            return (
              <box
                key={command.id}
                height={2}
                flexShrink={0}
                flexDirection="row"
                paddingLeft={1}
                paddingRight={2}
                alignItems="center"
                onMouseOver={() => onSelectedIndex(index)}
                onMouseUp={() => onRun(command)}
              >
                <text fg={active ? palette.accent : palette.panelRaised}>{active ? "▎" : " "}</text>
                <box flexDirection="column" flexGrow={1} minWidth={0} overflow="hidden">
                  <text
                    fg={active ? palette.text : palette.textMuted}
                    attributes={active ? TextAttributes.BOLD : 0}
                    wrapMode="none"
                  >
                    {command.title}
                  </text>
                  {command.description ? (
                    <text fg={palette.textSubtle} wrapMode="none">{command.description}</text>
                  ) : null}
                </box>
                <text fg={palette.textSubtle}>{command.shortcut ?? command.category}</text>
              </box>
            );
          }) : (
            <box height={3} paddingLeft={2} alignItems="center">
              <text fg={palette.textMuted}>No matching commands</text>
            </box>
          )}
        </scrollbox>
      </box>
    </box>
  );
}
