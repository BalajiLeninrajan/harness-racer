import { describe, expect, it } from "vitest";

import {
  codexAppServerDiagnostic,
  codexAppServerEnvironment,
  codexTurnStartParams,
} from "../src/server/adapters/codex.js";

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

  it("keeps Codex on its normal state database when the home is writable", () => {
    const environment = { HOME: "/home/test", PATH: "/bin" };
    const result = codexAppServerEnvironment(environment, {
      homeDirectory: "/home/test",
      canWrite: () => true,
      createOverlayHome: () => "/tmp/unused",
    });

    expect(result).toBe(environment);
  });

  it("isolates app-server SQLite state when Codex home is read-only", () => {
    const environment = { HOME: "/home/test", PATH: "/bin" };
    const result = codexAppServerEnvironment(environment, {
      homeDirectory: "/home/test",
      canWrite: (path) => {
        expect(path).toBe("/home/test/.codex");
        return false;
      },
      createOverlayHome: (sourceHome) => {
        expect(sourceHome).toBe("/home/test/.codex");
        return "/tmp/tps-codex-home";
      },
    });

    expect(result).toEqual({
      ...environment,
      CODEX_HOME: "/tmp/tps-codex-home",
      CODEX_SQLITE_HOME: "/tmp/tps-codex-home",
    });
    expect(environment).not.toHaveProperty("CODEX_SQLITE_HOME");
  });

  it("preserves an explicit SQLite home while overlaying a read-only Codex home", () => {
    const environment = {
      CODEX_HOME: "/readonly/codex",
      CODEX_SQLITE_HOME: "/chosen/state",
    };
    const result = codexAppServerEnvironment(environment, {
      canWrite: () => false,
      createOverlayHome: () => "/tmp/tps-codex-home",
    });

    expect(result).toEqual({
      CODEX_HOME: "/tmp/tps-codex-home",
      CODEX_SQLITE_HOME: "/chosen/state",
    });
  });

  it("reports useful app-server failures while redacting local and credential data", () => {
    const headerJwt = "eyJhbGciOiJIUzI1NiJ9.header-signature-value";
    const jsonJwt = "eyJhbGciOiJSUzI1NiJ9.json-signature-value";
    const diagnostic = codexAppServerDiagnostic([
      "WARNING: proceeding, even though we could not create PATH aliases",
      "Error: failed to initialize sqlite state runtime under /Users/test/.codex",
      "authorization: Bearer sk-secretvalue123456",
      `Authorization: Bearer ${headerJwt}`,
      `{"access_token":"${jsonJwt}"}`,
    ].join("\n"), "/Users/test");

    expect(diagnostic).toContain("failed to initialize sqlite state runtime under ~/.codex");
    expect(diagnostic).toContain("authorization=[redacted]");
    expect(diagnostic).not.toContain("/Users/test");
    expect(diagnostic).not.toContain("secretvalue");
    expect(diagnostic).not.toContain(headerJwt);
    expect(diagnostic).not.toContain(jsonJwt);
  });

  it("suppresses the PATH alias warning when it is the only stderr output", () => {
    expect(codexAppServerDiagnostic(
      "WARNING: proceeding, even though we could not create PATH aliases: Operation not permitted",
    )).toBeUndefined();
  });
});
