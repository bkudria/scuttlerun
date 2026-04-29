import { describe, it, expect, afterEach } from "vitest";
import { assertAnthropicApiKey, buildConfig } from "../src/cli.js";

describe("buildConfig", () => {
  it("parses a YAML file into a SessionConfig", async () => {
    const yaml = `
prompt: Write a haiku
model: claude-haiku-4-5
max_turns: 10
`;
    const config = await buildConfig([yaml], {});
    expect(config.prompt).toBe("Write a haiku");
    expect(config.model).toBe("claude-haiku-4-5");
    expect(config.max_turns).toBe(10);
  });

  it("merges multiple YAML strings", async () => {
    const base = `
prompt: base prompt
max_turns: 10
tools:
  - Read
  - Write
`;
    const override = `
prompt: override prompt
max_turns: 20
`;
    const config = await buildConfig([base, override], {});
    expect(config.prompt).toBe("override prompt");
    expect(config.max_turns).toBe(20);
    // tools should come from base (override didn't specify)
    expect(config.tools).toEqual(["Read", "Write"]);
  });

  it("applies CLI overrides", async () => {
    const yaml = `
prompt: original
model: claude-haiku-4-5
max_turns: 10
`;
    const config = await buildConfig([yaml], {
      model: "claude-sonnet-4-6",
      prompt: "overridden prompt",
      maxTurns: 30,
      effort: "max",
      tools: "Read,Grep,Glob",
      oracleModel: "claude-sonnet-4-6",
    });
    expect(config.model).toBe("claude-sonnet-4-6");
    expect(config.prompt).toBe("overridden prompt");
    expect(config.max_turns).toBe(30);
    expect(config.effort).toBe("max");
    expect(config.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(config.user.oracle_model).toBe("claude-sonnet-4-6");
  });
});

describe("assertAnthropicApiKey", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  afterEach(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("returns silently when ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(() => assertAnthropicApiKey()).not.toThrow();
  });

  it("throws an actionable error when ANTHROPIC_API_KEY is unset", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => assertAnthropicApiKey()).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => assertAnthropicApiKey()).toThrow(/README/);
  });

  it("throws when ANTHROPIC_API_KEY is empty", () => {
    process.env.ANTHROPIC_API_KEY = "";
    expect(() => assertAnthropicApiKey()).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("throws when ANTHROPIC_API_KEY is whitespace only", () => {
    process.env.ANTHROPIC_API_KEY = "   ";
    expect(() => assertAnthropicApiKey()).toThrow(/ANTHROPIC_API_KEY/);
  });
});
