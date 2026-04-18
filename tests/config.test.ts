import { describe, it, expect, vi } from "vitest";
import {
  parseSessionConfig,
  mergeRawConfigs,
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
      "Skill",
    ]);
    expect(config.model).toBe("claude-haiku-4-5");
    expect(config.permission_mode).toBe("bypassPermissions");
    expect(config.user.max_turns).toBe(0);
    expect(config.user.oracle_model).toBe("claude-haiku-4-5");
  });

  it("parses a full config with all fields", () => {
    const raw = {
      version: "1",
      prompt: "Write a haiku about the ocean",
      model: "claude-haiku-4-5",
      max_turns: 20,
      max_budget_usd: 1.0,
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
        max_turns: 5,
      },
      sdk: {
        system_prompt: "You are helpful.",
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
    expect(config.user.max_turns).toBe(5);
    expect(config.sdk.system_prompt).toBe("You are helpful.");
    expect(config.sdk.thinking).toEqual({ type: "adaptive" });
    expect(config.sdk.setting_sources).toEqual(["project"]);
  });

  it("defaults sdk.system_prompt to claude_code preset", () => {
    const config = parseSessionConfig({ prompt: "hi" });
    expect(config.sdk.system_prompt).toEqual({ preset: "claude_code" });
  });

  it("parses sdk.system_prompt as a string", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      sdk: { system_prompt: "Custom prompt" },
    });
    expect(config.sdk.system_prompt).toBe("Custom prompt");
  });

  it("parses sdk.system_prompt preset with append", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      sdk: {
        system_prompt: { preset: "claude_code", append: "Be concise." },
      },
    });
    expect(config.sdk.system_prompt).toEqual({
      preset: "claude_code",
      append: "Be concise.",
    });
  });

  it("rejects config without prompt", () => {
    expect(() => parseSessionConfig({})).toThrow();
  });

  it("rejects invalid effort level", () => {
    expect(() =>
      parseSessionConfig({ prompt: "hi", effort: "extreme" })
    ).toThrow();
  });

  it("accepts xhigh effort level", () => {
    const config = parseSessionConfig({ prompt: "hi", effort: "xhigh" });
    expect(config.effort).toBe("xhigh");
  });

  it("rejects invalid permission mode", () => {
    expect(() =>
      parseSessionConfig({ prompt: "hi", permission_mode: "yolo" })
    ).toThrow();
  });

  it("rejects negative max_turns", () => {
    expect(() =>
      parseSessionConfig({ prompt: "hi", user: { max_turns: -1 } })
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

  it("parses valid stdio MCP server config (with type)", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      sdk: { mcp_servers: { myserver: { type: "stdio", command: "npx", args: ["-y", "server"] } } },
    });
    expect(config.sdk.mcp_servers).toEqual({
      myserver: { type: "stdio", command: "npx", args: ["-y", "server"] },
    });
  });

  it("parses valid stdio MCP server config (without type, defaults to stdio)", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      sdk: { mcp_servers: { myserver: { command: "npx" } } },
    });
    expect(config.sdk.mcp_servers).toEqual({
      myserver: { command: "npx" },
    });
  });

  it("parses valid SSE MCP server config", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      sdk: { mcp_servers: { remote: { type: "sse", url: "https://example.com/sse" } } },
    });
    expect(config.sdk.mcp_servers).toEqual({
      remote: { type: "sse", url: "https://example.com/sse" },
    });
  });

  it("parses valid HTTP MCP server config", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      sdk: { mcp_servers: { remote: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer tok" } } } },
    });
    expect(config.sdk.mcp_servers).toEqual({
      remote: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer tok" } },
    });
  });

  it("parses valid SDK MCP server config", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      sdk: { mcp_servers: { builtin: { type: "sdk", name: "my-sdk-server" } } },
    });
    expect(config.sdk.mcp_servers).toEqual({
      builtin: { type: "sdk", name: "my-sdk-server" },
    });
  });

  it("rejects MCP server config with invalid type", () => {
    expect(() => parseSessionConfig({
      prompt: "hi",
      sdk: { mcp_servers: { bad: { type: "invalid", command: "foo" } } },
    })).toThrow();
  });

  it("rejects stdio MCP server config missing command", () => {
    expect(() => parseSessionConfig({
      prompt: "hi",
      sdk: { mcp_servers: { bad: { type: "stdio" } } },
    })).toThrow();
  });

  it("parses valid agent definition", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      sdk: {
        agents: {
          reviewer: {
            description: "Reviews code",
            prompt: "Review the code for issues",
            tools: ["Read", "Grep"],
            model: "haiku",
            maxTurns: 5,
          },
        },
      },
    });
    expect(config.sdk.agents).toEqual({
      reviewer: {
        description: "Reviews code",
        prompt: "Review the code for issues",
        tools: ["Read", "Grep"],
        model: "haiku",
        maxTurns: 5,
      },
    });
  });

  it("rejects agent definition missing required description", () => {
    expect(() => parseSessionConfig({
      prompt: "hi",
      sdk: { agents: { bad: { prompt: "do stuff" } } },
    })).toThrow();
  });

  it("rejects agent definition missing required prompt", () => {
    expect(() => parseSessionConfig({
      prompt: "hi",
      sdk: { agents: { bad: { description: "does stuff" } } },
    })).toThrow();
  });

  it("passes through unknown fields in MCP server config (forward compat)", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      sdk: { mcp_servers: { myserver: { command: "npx", futureField: true } } },
    });
    const server = (config.sdk.mcp_servers as Record<string, Record<string, unknown>>)?.myserver;
    expect(server.command).toBe("npx");
    expect(server.futureField).toBe(true);
  });

  it("passes through unknown fields in agent definition (forward compat)", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      sdk: { agents: { a: { description: "d", prompt: "p", futureField: 42 } } },
    });
    const agent = (config.sdk.agents as Record<string, Record<string, unknown>>)?.a;
    expect(agent.description).toBe("d");
    expect(agent.futureField).toBe(42);
  });

  it("parses extended agent definition fields (initialPrompt, background, memory, effort, permissionMode)", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      sdk: {
        agents: {
          worker: {
            description: "Worker agent",
            prompt: "Do work",
            initialPrompt: "start here",
            background: true,
            memory: "project",
            effort: "xhigh",
            permissionMode: "acceptEdits",
          },
        },
      },
    });
    const agent = (config.sdk.agents as Record<string, Record<string, unknown>>)?.worker;
    expect(agent.initialPrompt).toBe("start here");
    expect(agent.background).toBe(true);
    expect(agent.memory).toBe("project");
    expect(agent.effort).toBe("xhigh");
    expect(agent.permissionMode).toBe("acceptEdits");
  });

  it("accepts full model id string in agent definition", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      sdk: {
        agents: {
          a: { description: "d", prompt: "p", model: "claude-opus-4-7" },
        },
      },
    });
    const agent = (config.sdk.agents as Record<string, Record<string, unknown>>)?.a;
    expect(agent.model).toBe("claude-opus-4-7");
  });

  it("rejects invalid memory scope in agent definition", () => {
    expect(() => parseSessionConfig({
      prompt: "hi",
      sdk: { agents: { a: { description: "d", prompt: "p", memory: "global" } } },
    })).toThrow();
  });

  it("parses valid sdk.plugins array", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      sdk: {
        plugins: [
          { type: "local", path: "/absolute/path/to/plugin" },
          { type: "local", path: "~/my-plugin" },
        ],
      },
    });
    expect(config.sdk.plugins).toEqual([
      { type: "local", path: "/absolute/path/to/plugin" },
      { type: "local", path: "~/my-plugin" },
    ]);
  });

  it("defaults sdk.plugins to undefined when not specified", () => {
    const config = parseSessionConfig({ prompt: "hi" });
    expect(config.sdk.plugins).toBeUndefined();
  });

  it("accepts empty sdk.plugins array", () => {
    const config = parseSessionConfig({
      prompt: "hi",
      sdk: { plugins: [] },
    });
    expect(config.sdk.plugins).toEqual([]);
  });

  it("rejects sdk.plugins entry missing path", () => {
    expect(() => parseSessionConfig({
      prompt: "hi",
      sdk: { plugins: [{ type: "local" }] },
    })).toThrow();
  });

  it("rejects sdk.plugins entry with invalid type", () => {
    expect(() => parseSessionConfig({
      prompt: "hi",
      sdk: { plugins: [{ type: "remote", path: "/foo" }] },
    })).toThrow();
  });
});

describe("mergeRawConfigs", () => {
  it("throws when no configs provided", () => {
    expect(() => mergeRawConfigs()).toThrow("At least one config is required");
  });

  it("returns the single config unchanged", () => {
    const result = mergeRawConfigs({ prompt: "hi", model: "haiku" });
    expect(result).toEqual({ prompt: "hi", model: "haiku" });
  });

  it("overrides scalar values from later configs", () => {
    const result = mergeRawConfigs(
      { prompt: "base", model: "haiku" },
      { model: "sonnet" },
    );
    expect(result).toEqual({ prompt: "base", model: "sonnet" });
  });

  it("replaces arrays entirely (no merge)", () => {
    const result = mergeRawConfigs(
      { tools: ["Read", "Write"] },
      { tools: ["Bash"] },
    );
    expect(result).toEqual({ tools: ["Bash"] });
  });

  it("deep-merges nested objects", () => {
    const result = mergeRawConfigs(
      { sandbox: { enabled: true, network: { allowed_domains: [] } } },
      { sandbox: { network: { allow_local_binding: true } } },
    );
    expect(result).toEqual({
      sandbox: {
        enabled: true,
        network: { allowed_domains: [], allow_local_binding: true },
      },
    });
  });

  it("overrides object with scalar", () => {
    const result = mergeRawConfigs(
      { sandbox: { enabled: true } },
      { sandbox: false as unknown as Record<string, unknown> },
    );
    expect(result).toEqual({ sandbox: false });
  });

  it("skips __proto__ keys during merge", () => {
    const base = { prompt: "hi" };
    const override = JSON.parse('{"__proto__": {"polluted": true}, "model": "sonnet"}');
    const result = mergeRawConfigs(base, override);
    expect(result.model).toBe("sonnet");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect("__proto__" in result && typeof result.__proto__ === "object" && result.__proto__ !== null && "polluted" in (result.__proto__ as Record<string, unknown>)).toBe(false);
  });

  it("skips constructor keys during merge", () => {
    const base = { prompt: "hi" };
    const override = { constructor: { prototype: { polluted: true } }, model: "sonnet" } as Record<string, unknown>;
    const result = mergeRawConfigs(base, override);
    expect(result.model).toBe("sonnet");
    // constructor should not be an own property on the result
    expect(Object.hasOwn(result, "constructor")).toBe(false);
  });

  it("merges three configs in order", () => {
    const result = mergeRawConfigs(
      { prompt: "a", model: "haiku", user: { persona: "dev" } },
      { model: "sonnet" },
      { user: { max_turns: 3 } },
    );
    expect(result).toEqual({
      prompt: "a",
      model: "sonnet",
      user: { persona: "dev", max_turns: 3 },
    });
  });
});

describe("parseSessionConfig tool validation", () => {
  it("warns on unknown tool names to stderr", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    parseSessionConfig({ prompt: "hi", tools: ["Read", "TaskCreate"] });
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("[scuttlerun] WARNING");
    expect(out).toContain("TaskCreate");
    spy.mockRestore();
  });

  it("does not warn on recognized SDK tool names", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    parseSessionConfig({
      prompt: "hi",
      tools: [
        "Read",
        "Write",
        "Bash",
        "TodoWrite",
        "Task",
        "Skill",
        "EnterPlanMode",
      ],
    });
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).not.toContain("WARNING");
    spy.mockRestore();
  });

  it("warns on unknown tool names in disallowed_tools", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    parseSessionConfig({ prompt: "hi", disallowed_tools: ["TaskUpdate"] });
    const out = spy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("[scuttlerun] WARNING");
    expect(out).toContain("TaskUpdate");
    expect(out).toContain("disallowed_tools");
    spy.mockRestore();
  });

  it("emits one warning per unique unknown name", () => {
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    parseSessionConfig({
      prompt: "hi",
      tools: ["TaskCreate", "TaskCreate"],
    });
    const warnings = spy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("WARNING"));
    expect(warnings.length).toBe(1);
    spy.mockRestore();
  });
});
