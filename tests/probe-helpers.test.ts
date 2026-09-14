import { afterEach, describe, expect, it, vi } from "vitest";

import { bounded, normalizeModels, notInstalled, probeFailure } from "../src/server/adapters/lib/probe.js";

describe("normalizeModels", () => {
  it("names the preferred model as default when it is listed", () => {
    expect(normalizeModels([{ id: "a", label: "A", isDefault: true }, { id: "b", label: "B" }], "b")).toEqual({
      models: [{ id: "a", label: "A" }, { id: "b", label: "B", isDefault: true }],
      defaultModel: "b",
    });
  });

  it("falls back to the flagged entry, then the first, when the preferred model is not listed", () => {
    expect(normalizeModels([{ id: "a", label: "A" }, { id: "b", label: "B", isDefault: true }], "gone")).toEqual({
      models: [{ id: "a", label: "A" }, { id: "b", label: "B", isDefault: true }],
      defaultModel: "b",
    });
    expect(normalizeModels([{ id: "a", label: "A" }, { id: "b", label: "B" }], "gone")).toEqual({
      models: [{ id: "a", label: "A", isDefault: true }, { id: "b", label: "B" }],
      defaultModel: "a",
    });
  });

  it("leaves exactly one default when several entries were flagged", () => {
    const { models } = normalizeModels([{ id: "a", label: "A", isDefault: true }, { id: "b", label: "B", isDefault: true }]);
    expect(models.filter((model) => model.isDefault).map((model) => model.id)).toEqual(["a"]);
  });

  it("drops repeated ids, keeping the first", () => {
    expect(normalizeModels([{ id: "a", label: "first" }, { id: "a", label: "second" }]).models).toEqual([{ id: "a", label: "first", isDefault: true }]);
  });

  it("names no default for an empty list", () => {
    expect(normalizeModels([], "a")).toEqual({ models: [] });
  });
});

describe("notInstalled", () => {
  it("is true only for an ENOENT spawn failure, including one wrapped as a cause", () => {
    const enoent = Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
    expect(notInstalled(enoent)).toBe(true);
    expect(notInstalled(new Error("not on PATH", { cause: enoent }))).toBe(true);
    expect(notInstalled(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
    expect(notInstalled(new Error("exited with code 1"))).toBe(false);
    expect(notInstalled("ENOENT")).toBe(false);
  });
});

describe("probeFailure", () => {
  it("reports an absent CLI as not installed and any other failure as installed but empty", () => {
    expect(probeFailure(Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }))).toEqual({
      installed: false, authenticated: null, models: [], message: "spawn codex ENOENT",
    });
    expect(probeFailure(new Error("agy models did not finish within 60s"), "1.1.28")).toEqual({
      installed: true, authenticated: null, models: [], version: "1.1.28", message: "agy models did not finish within 60s",
    });
    expect(probeFailure({ message: "rpc says no" })).toMatchObject({ installed: true, message: "rpc says no" });
  });
});

describe("bounded", () => {
  afterEach(() => vi.useRealTimers());

  it("settles with the work when it finishes in time and leaves the teardown alone", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    await expect(bounded(Promise.resolve("done"), 1_000, "too slow", onTimeout)).resolves.toBe("done");
    await expect(bounded(Promise.reject(new Error("broke")), 1_000, "too slow", onTimeout)).rejects.toThrow("broke");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("tears down and rejects with the message once the bound elapses", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const result = expect(bounded(new Promise(() => {}), 20_000, "handshake did not finish within 20s", onTimeout)).rejects.toThrow("handshake did not finish within 20s");
    await vi.advanceTimersByTimeAsync(19_999);
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(onTimeout).toHaveBeenCalledOnce();
  });
});
