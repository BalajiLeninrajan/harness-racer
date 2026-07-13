import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { ACCENT } from "../theme.js";
import type { Phase } from "../types.js";

export interface HeaderProps {
  phase: Phase;
}

export function Header({ phase }: HeaderProps) {
  const step = phase === "lineup" || phase === "picker"
    ? "1 · racers"
    : phase === "configure"
      ? "2 · grid"
      : phase === "results"
        ? "4 · results"
        : "terminal mode";
  return (
    <Box justifyContent="space-between" marginBottom={1}>
      <Text bold color={ACCENT}>harness.racer</Text>
      <Text dimColor>{step}</Text>
    </Box>
  );
}

export interface FooterProps {
  children: ReactNode;
}

export function Footer({ children }: FooterProps) {
  return <Box marginTop={1}><Text dimColor>{children}</Text></Box>;
}
