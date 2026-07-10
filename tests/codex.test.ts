import { describe, expect, it } from "vitest";

import { codexTurnStartParams } from "../src/server/adapters/codex.js";

describe("Codex adapter protocol", () => {
  it("uses the current app-server text input shape and explicit benchmark permissions", () => {
    expect(codexTurnStartParams("thread-1", "gpt-5.5", "Reply with the payload.")).toEqual({
      threadId: "thread-1",
      model: "gpt-5.5",
      effort: "medium",
      input: [{
        type: "text",
        text: "Reply with the payload.",
        text_elements: [],
      }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    });
  });

  it("can pin the model-advertised reasoning effort instead of inheriting local config", () => {
    expect(codexTurnStartParams("thread-1", "gpt-5.6-sol", "Reply.", "low")).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "low",
    });
  });
});
