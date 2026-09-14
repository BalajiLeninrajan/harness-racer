import { describe, expect, it } from "vitest";

import { errorMessage, outputTokensFrom, recordFrom, stringFrom, stripAnsi } from "../src/server/adapters/lib/json.js";

describe("json helpers", () => {
  it("recordFrom accepts plain objects only", () => {
    expect(recordFrom({ a: 1 })).toEqual({ a: 1 });
    expect(recordFrom([1])).toBeUndefined();
    expect(recordFrom(null)).toBeUndefined();
    expect(recordFrom("x")).toBeUndefined();
  });

  it("stringFrom trims and drops blanks and non-strings", () => {
    expect(stringFrom("  gpt-5 ")).toBe("gpt-5");
    expect(stringFrom("   ")).toBeUndefined();
    expect(stringFrom(5)).toBeUndefined();
  });

  it("errorMessage reads Errors, error-shaped objects and bare values", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage({ code: -32000, message: "rpc failed" })).toBe("rpc failed");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage({ code: 1 })).toBe("[object Object]");
  });

  it("stripAnsi removes CSI sequences", () => {
    expect(stripAnsi("\u001b[32mgemini-3\u001b[0m\tGemini 3 [preview]")).toBe("gemini-3\tGemini 3 [preview]");
    expect(stripAnsi("\u001b[?25lplain\u001b[1;31mred")).toBe("plainred");
  });

  it("outputTokensFrom reads the ACP usage shapes Cursor and Grok report", () => {
    expect(outputTokensFrom({ usage: { outputTokens: 11 } })).toBe(11);
    expect(outputTokensFrom({ usage: { output_tokens: 7 } })).toBe(7);
    expect(outputTokensFrom({ result: { tokenUsage: { completion_tokens: 3 } } })).toBe(3);
    expect(outputTokensFrom({ usage: { outputTokens: Number.NaN } })).toBeUndefined();
    expect(outputTokensFrom({ stopReason: "end_turn" })).toBeUndefined();
    expect(outputTokensFrom(null)).toBeUndefined();
  });
});
