export type JsonRecord = Record<string, unknown>;

/** The value as a plain object, or undefined for anything else (arrays included). */
export function recordFrom(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

/** The value trimmed, or undefined when it is not a string or is blank. */
export function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A message for anything thrown or returned as an error: an Error, a JSON-RPC error object, or a bare value. */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  const message = recordFrom(value)?.message;
  if (typeof message === "string") return message;
  return String(value);
}

export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

/**
 * The output-token count an ACP agent reports on a prompt result. Cursor and
 * Grok speak the same protocol and put it in the same places; the other
 * harnesses have their own, narrower shapes and their own readers.
 */
export function outputTokensFrom(value: unknown): number | undefined {
  const record = recordFrom(value);
  if (!record) return undefined;
  for (const candidate of [record.outputTokens, record.output_tokens, record.completionTokens, record.completion_tokens]) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  for (const nested of [record.usage, record.tokenUsage, record.result]) {
    const tokens = outputTokensFrom(nested);
    if (tokens !== undefined) return tokens;
  }
  return undefined;
}
