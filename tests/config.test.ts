import { describe, it, expect } from "vitest";
import {
  parseSessionConfig,
} from "../src/config.js";

describe("parseSessionConfig", () => {
  it("parses a minimal config with only prompt", () => {
    const raw = { prompt: "Write a haiku" };
    const config = parseSessionConfig(raw);
    expect(config.prompt).toBe("Write a haiku");
  });

  it("applies defaults for omitted fields", () => {
    const config = parseSessionConfig({ prompt: "Hello" });
    expect(config.max_turns).toBe(50);
    expect(config.effort).toBe("high");
    expect(config.tools).toEqual([
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Glob",
      "Grep",
      "AskUserQuestion",
    ]);
    expect(config.model).toBe("claude-haiku-4-5");
    expect(config.permission_mode).toBe("bypassPermissions");
    expect(config.user.turn_policy).toBe("single");
    expect(config.user.oracle_model).toBe("claude-haiku-4-5");
  });

  it("parses a full config with all fields", () => {
    const raw = {
      version: "1",
      prompt: "Write a haiku about the ocean",
      model: "claude-haiku-4-5",
      max_turns: 20,
      max_budget_usd: 1.0,
      system_prompt: "You are helpful.",
      effort: "max" as const,
      tools: ["Read", "Write", "AskUserQuestion"],
      disallowed_tools: ["Agent"],
      project: {
        claude_md: "Use clear language.",
        skills: ["~/.claude/skills/haiku-writer"],
        settings: { key: "value" },
        git_init: true,
      },
      permission_mode: "default" as const,
      user: {
        persona: "You are a beginner programmer.",
        oracle_model: "claude-sonnet-4-6",
        turn_policy: "reactive" as const,
        max_user_turns: 5,
      },
      sdk: {
        thinking: { type: "adaptive" as const },
        mcp_servers: {},
        agents: {},
        env: {},
        setting_sources: ["project" as const],
      },
    };
    const config = parseSessionConfig(raw);
    expect(config.prompt).toBe("Write a haiku about the ocean");
    expect(config.model).toBe("claude-haiku-4-5");
    expect(config.max_turns).toBe(20);
    expect(config.max_budget_usd).toBe(1.0);
    expect(config.effort).toBe("max");
    expect(config.tools).toEqual(["Read", "Write", "AskUserQuestion"]);
    expect(config.disallowed_tools).toEqual(["Agent"]);
    expect(config.project?.claude_md).toBe("Use clear language.");
    expect(config.project?.git_init).toBe(true);
    expect(config.user.turn_policy).toBe("reactive");
    expect(config.user.max_user_turns).toBe(5);
    expect(config.sdk.thinking).toEqual({ type: "adaptive" });
    expect(config.sdk.setting_sources).toEqual(["project"]);
  });

  it("rejects config without prompt", () => {
    expect(() => parseSessionConfig({})).toThrow();
  });

  it("rejects invalid effort level", () => {
    expect(() =>
      parseSessionConfig({ prompt: "hi", effort: "extreme" })
    ).toThrow();
  });

  it("rejects invalid permission mode", () => {
    expect(() =>
      parseSessionConfig({ prompt: "hi", permission_mode: "yolo" })
    ).toThrow();
  });

  it("rejects invalid turn policy", () => {
    expect(() =>
      parseSessionConfig({ prompt: "hi", user: { turn_policy: "scripted" } })
    ).toThrow();
  });

  it("auto-sets sdk.setting_sources to ['project'] when project is present", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      project: { claude_md: "test" },
    });
    expect(config.sdk.setting_sources).toEqual(["project"]);
  });

  it("does not auto-set setting_sources when project is absent", () => {
    const config = parseSessionConfig({ prompt: "hi" });
    expect(config.sdk.setting_sources).toEqual([]);
  });

  it("respects explicit sdk.setting_sources even with project present", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      project: { claude_md: "test" },
      sdk: { setting_sources: ["user", "project"] },
    });
    expect(config.sdk.setting_sources).toEqual(["user", "project"]);
  });

  it("defaults project.git_init to false", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      project: { claude_md: "test" },
    });
    expect(config.project?.git_init).toBe(false);
  });

  it("applies sandbox defaults when omitted", () => {
    const config = parseSessionConfig({ prompt: "hi" });
    expect(config.sandbox.enabled).toBe(true);
    expect(config.sandbox.network.allowed_domains).toEqual([]);
    expect(config.sandbox.network.allow_local_binding).toBe(false);
    expect(config.sandbox.filesystem.deny_read).toEqual([
      "~/.ssh",
      "~/.aws",
      "~/.config/gcloud",
    ]);
    expect(config.sandbox.filesystem.allow_write).toEqual([]);
    expect(config.sandbox.filesystem.deny_write).toEqual([".env"]);
  });

  it("allows sandbox to be explicitly disabled", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      sandbox: { enabled: false },
    });
    expect(config.sandbox.enabled).toBe(false);
  });

  it("overrides sandbox network allowed_domains (array replace)", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      sandbox: {
        network: {
          allowed_domains: ["registry.npmjs.org", "api.anthropic.com"],
        },
      },
    });
    expect(config.sandbox.network.allowed_domains).toEqual([
      "registry.npmjs.org",
      "api.anthropic.com",
    ]);
  });

  it("overrides sandbox filesystem deny_read", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      sandbox: { filesystem: { deny_read: ["~/.ssh"] } },
    });
    expect(config.sandbox.filesystem.deny_read).toEqual(["~/.ssh"]);
    // Other filesystem defaults still apply
    expect(config.sandbox.filesystem.allow_write).toEqual([]);
    expect(config.sandbox.filesystem.deny_write).toEqual([".env"]);
  });

  it("parses full sandbox config", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      sandbox: {
        enabled: true,
        network: {
          allowed_domains: ["example.com"],
          allow_local_binding: true,
        },
        filesystem: {
          deny_read: ["/secret"],
          allow_write: ["/extra"],
          deny_write: [".credentials"],
        },
      },
    });
    expect(config.sandbox).toEqual({
      enabled: true,
      network: {
        allowed_domains: ["example.com"],
        allow_local_binding: true,
      },
      filesystem: {
        deny_read: ["/secret"],
        allow_write: ["/extra"],
        deny_write: [".credentials"],
      },
    });
  });

  it("parses thinking config variants", () => {
    const adaptive = parseSessionConfig({
      prompt: "hi",
      sdk: { thinking: { type: "adaptive" } },
    });
    expect(adaptive.sdk.thinking).toEqual({ type: "adaptive" });

    const enabled = parseSessionConfig({
      prompt: "hi",
      sdk: { thinking: { type: "enabled", budget_tokens: 5000 } },
    });
    expect(enabled.sdk.thinking).toEqual({
      type: "enabled",
      budget_tokens: 5000,
    });

    const disabled = parseSessionConfig({
      prompt: "hi",
      sdk: { thinking: { type: "disabled" } },
    });
    expect(disabled.sdk.thinking).toEqual({ type: "disabled" });
  });
});
