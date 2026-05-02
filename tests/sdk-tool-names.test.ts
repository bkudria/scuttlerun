import { describe, it, expect } from "vitest";
import { getKnownSdkToolNames, _resetCacheForTests } from "../src/sdk-tool-names.js";

describe("getKnownSdkToolNames", () => {
  it("returns SDK tool names including canonical File* aliases", () => {
    _resetCacheForTests();
    const names = getKnownSdkToolNames();
    expect(names.has("Bash")).toBe(true);
    expect(names.has("Read")).toBe(true);
    expect(names.has("Write")).toBe(true);
    expect(names.has("Edit")).toBe(true);
    expect(names.has("TodoWrite")).toBe(true);
    expect(names.has("Skill")).toBe(true);
  });

  it("does not include harness-only Task* names", () => {
    _resetCacheForTests();
    const names = getKnownSdkToolNames();
    expect(names.has("TaskCreate")).toBe(false);
    expect(names.has("TaskUpdate")).toBe(false);
    expect(names.has("TaskList")).toBe(false);
    expect(names.has("TaskGet")).toBe(false);
  });

  it("never throws even when the SDK layout is unexpected", () => {
    _resetCacheForTests();
    expect(() => getKnownSdkToolNames()).not.toThrow();
  });
});
