import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildConfig } from "../src/cli.js";
import { parseSessionConfig } from "../src/config.js";

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
      cwd: "/tmp/custom",
    });
    expect(config.model).toBe("claude-sonnet-4-6");
    expect(config.prompt).toBe("overridden prompt");
    expect(config.max_turns).toBe(30);
    expect(config.effort).toBe("max");
    expect(config.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(config.user.oracle_model).toBe("claude-sonnet-4-6");
    expect(config.cwd).toBe("/tmp/custom");
  });

  it("applies output override", async () => {
    const yaml = `prompt: hi`;
    const config = await buildConfig([yaml], { output: "custom.jsonl" });
    expect(config.output.events).toBe("custom.jsonl");
  });
});
