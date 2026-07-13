import { Box, Text } from "ink";
import { ACCENT } from "../theme.js";
import { Footer, Header } from "./chrome.js";

export interface LoadingViewProps {
  spinner: string;
}

export function LoadingView({ spinner }: LoadingViewProps) {
  return (
    <Box flexDirection="column" padding={1} width="100%">
      <Header phase="loading" />
      <Box borderStyle="round" borderColor={ACCENT} paddingX={2} paddingY={1}>
        <Text color={ACCENT}>{spinner} </Text><Text>Scanning local coding-agent harnesses…</Text>
      </Box>
      <Footer>q quit</Footer>
    </Box>
  );
}
