// Provider metadata, streamed output, and errors all cross a terminal boundary.
// Remove control strings before passing any of them to the native renderer.
const TERMINAL_STRING_SEQUENCE =
  /(?:(?:\u001b[\]PX^_])|[\u0090\u0098\u009d-\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/gi;
const ANSI_SEQUENCE =
  /[\u001b\u009b][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;
const UNSAFE_OUTPUT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function sanitizeTerminalOutput(value: string, maxLength = 12_000): string {
  const limit = Math.max(1, Math.floor(maxLength));
  return value
    .replace(TERMINAL_STRING_SEQUENCE, "")
    .replace(ANSI_SEQUENCE, "")
    .replace(UNSAFE_OUTPUT_CONTROL, "")
    .replace(/\r/g, "")
    .slice(-limit);
}

export function sanitizeTerminalText(
  value: string,
  fallback = "Unknown",
  maxLength = 160,
): string {
  const limit = Math.max(1, Math.floor(maxLength));
  const normalized = sanitizeTerminalOutput(value, Math.max(limit * 4, 2_000))
    .replace(/[\t\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized.slice(0, limit) || fallback;
}
