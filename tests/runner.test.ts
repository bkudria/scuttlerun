import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runSession } from "../src/runner.js";
import type { SessionConfig } from "../src/config.js";

// Mock all dependencies
vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  return {
    query: vi.fn(),
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY: actual.SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  };
});

import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@anthropic-ai/claude-agent-sdk";
const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = {
        parse: mockParse,
      };
    },
  };
});
vi.mock("../src/project.js", () => {
  return {
    createProjectDir: vi.fn().mockResolvedValue("/tmp/scuttlerun-project-test123"),
    scaffoldProject: vi
      .fn()
      .mockResolvedValue({ projectPath: "/tmp/scuttlerun-project-scaffold123" }),
    resolveSkillPath: vi.fn((p: string) => p),
  };
});
vi.mock("../src/cleanup.js", () => {
  return {
    cleanOldProjects: vi.fn().mockResolvedValue(0),
    WORKSPACE_CLEANUP_AGE_DAYS: 7,
  };
});
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    mkdirSync: vi.fn(),
  };
});

import { query as mockQueryFn } from "@anthropic-ai/claude-agent-sdk";
import {
  createProjectDir as mockCreateProjectDir,
  scaffoldProject as mockScaffoldProject,
  resolveSkillPath as mockResolveSkillPath,
} from "../src/project.js";
import { cleanOldProjects as mockCleanOldProjects } from "../src/cleanup.js";

function minConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    prompt: "Write a haiku",
    model: "claude-haiku-4-5",
    max_turns: 50,
    effort: "high",
    tools: ["Read", "Write", "AskUserQuestion", "Skill"],
    permission_mode: "bypassPermissions",
    user: {
      oracle_model: "claude-haiku-4-5",
      max_turns: 0,
    },
    sdk: { system_prompt: { preset: "claude_code" as const }, setting_sources: [] },
    sandbox: {
      enabled: true,
      network: {
        allowed_domains: [],
        allow_local_binding: false,
      },
      filesystem: {
        deny_read: ["~/.ssh", "~/.aws", "~/.config/gcloud"],
        allow_write: [],
        deny_write: [".env"],
      },
    },
    ...overrides,
  };
}

// Helper to create a mock async generator that simulates SDK messages
function createMockQuery(messages: Array<Record<string, unknown>>) {
  const mockQuery = {
    close: vi.fn(),
    interrupt: vi.fn().mockResolvedValue(undefined),
    [Symbol.asyncIterator]: async function* () {
      for (const msg of messages) {
        yield msg;
      }
    },
  };
  return mockQuery;
}

// Capture stdout
let stdoutOutput: string;
const originalStdoutWrite = process.stdout.write;

describe("runSession", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (mockCreateProjectDir as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/tmp/scuttlerun-project-test123",
    );
    (mockScaffoldProject as ReturnType<typeof vi.fn>).mockResolvedValue({
      projectPath: "/tmp/scuttlerun-project-scaffold123",
    });
    (mockCleanOldProjects as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    stdoutOutput = "";
    process.stdout.write = ((chunk: string) => {
      stdoutOutput += chunk;
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
  });

  it("runs a single-turn session to completion", async () => {
    const mockQuery = createMockQuery([
      {
        type: "system",
        subtype: "init",
        session_id: "test-session-1",
        tools: ["Read", "Write"],
        model: "claude-haiku-4-5",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is your haiku." }],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "test-session-1",
        stop_reason: "end_turn",
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.001,
        duration_ms: 5000,
        usage: { input_tokens: 100, output_tokens: 50 },
        result: "Here is your haiku.",
      },
    ]);

    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

    const config = minConfig();
    const result = await runSession(config);

    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("test-session-1");
    expect(mockQuery.close).toHaveBeenCalled();
  });

  it("swallows cleanup rejections so the session still runs", async () => {
    (mockCleanOldProjects as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("readdir failed"),
    );

    const mockQuery = createMockQuery([
      {
        type: "system",
        subtype: "init",
        session_id: "test-cleanup-reject",
        tools: ["Read", "Write"],
        model: "claude-haiku-4-5",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "test-cleanup-reject",
        stop_reason: "end_turn",
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.001,
        duration_ms: 1000,
        usage: { input_tokens: 10, output_tokens: 5 },
        result: "ok",
      },
    ]);

    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

    const result = await runSession(minConfig());

    expect(result.exitCode).toBe(0);
    expect(mockCleanOldProjects).toHaveBeenCalled();
  });

  it("always creates a temp dir even without project config", async () => {
    const mockQuery = createMockQuery([
      {
        type: "system",
        subtype: "init",
        session_id: "s-noproject",
        tools: [],
        model: "claude-haiku-4-5",
      },
      {
        type: "result",
        subtype: "success",
        session_id: "s-noproject",
        stop_reason: "end_turn",
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.001,
        duration_ms: 1000,
        usage: { input_tokens: 50, output_tokens: 20 },
        result: "Done",
      },
    ]);

    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

    // No project config
    await runSession(minConfig());

    expect(mockCreateProjectDir).toHaveBeenCalled();
  });

  it("scaffolds project when project config is present", async () => {
    const mockQuery = createMockQuery([
      {
        type: "system",
        subtype: "init",
        session_id: "s-project",
        tools: [],
        model: "claude-haiku-4-5",
      },
      {
        type: "result",
        subtype: "success",
        session_id: "s-project",
        stop_reason: "end_turn",
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.001,
        duration_ms: 1000,
        usage: { input_tokens: 50, output_tokens: 20 },
        result: "Done",
      },
    ]);

    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

    await runSession(
      minConfig({
        project: { claude_md: "Test", git_init: false },
      }),
    );

    expect(mockScaffoldProject).toHaveBeenCalled();
    expect(mockCreateProjectDir).not.toHaveBeenCalled();
  });

  it("prints transcript to stdout", async () => {
    const mockQuery = createMockQuery([
      {
        type: "system",
        subtype: "init",
        session_id: "s-transcript",
        tools: [],
        model: "claude-haiku-4-5",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is your haiku." }],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "s-transcript",
        stop_reason: "end_turn",
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.001,
        duration_ms: 5000,
        usage: { input_tokens: 100, output_tokens: 50 },
        result: "Here is your haiku.",
      },
    ]);

    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);
    await runSession(minConfig());

    // Should contain YAML header, conversation entries, and footer
    expect(stdoutOutput).toContain("session: s-transcript");
    expect(stdoutOutput).toContain("conversation:");
    expect(stdoutOutput).toContain("- user:");
    expect(stdoutOutput).toContain("Write a haiku");
    expect(stdoutOutput).toContain("- assistant:");
    expect(stdoutOutput).toContain("Here is your haiku.");
    expect(stdoutOutput).toContain("turns:");
  });

  it("handles error_max_turns with exit code 7", async () => {
    const mockQuery = createMockQuery([
      {
        type: "system",
        subtype: "init",
        session_id: "s2",
        tools: [],
        model: "claude-haiku-4-5",
      },
      {
        type: "result",
        subtype: "error_max_turns",
        session_id: "s2",
        stop_reason: null,
        is_error: true,
        num_turns: 50,
        total_cost_usd: 1.0,
        duration_ms: 60000,
        usage: { input_tokens: 5000, output_tokens: 3000 },
        errors: ["Max turns reached"],
      },
    ]);

    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);
    const result = await runSession(minConfig());

    expect(result.exitCode).toBe(7);
  });

  it("handles error_max_budget_usd with exit code 5", async () => {
    const mockQuery = createMockQuery([
      {
        type: "system",
        subtype: "init",
        session_id: "s3",
        tools: [],
        model: "claude-haiku-4-5",
      },
      {
        type: "result",
        subtype: "error_max_budget_usd",
        session_id: "s3",
        stop_reason: null,
        is_error: true,
        num_turns: 10,
        total_cost_usd: 1.0,
        duration_ms: 30000,
        usage: { input_tokens: 3000, output_tokens: 2000 },
        errors: ["Budget exceeded"],
      },
    ]);

    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);
    const result = await runSession(minConfig());

    expect(result.exitCode).toBe(5);
  });

  it("handles error_during_execution with exit code 2", async () => {
    const mockQuery = createMockQuery([
      {
        type: "system",
        subtype: "init",
        session_id: "s4",
        tools: [],
        model: "claude-haiku-4-5",
      },
      {
        type: "result",
        subtype: "error_during_execution",
        session_id: "s4",
        stop_reason: null,
        is_error: true,
        // Omit num_turns and total_cost_usd to cover || 0 fallback branches
        duration_ms: 2000,
        usage: { input_tokens: 100, output_tokens: 50 },
        errors: ["Runtime error occurred"],
      },
    ]);

    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);
    const result = await runSession(minConfig());

    expect(result.exitCode).toBe(2);
  });

  it("passes canUseTool callback that handles AskUserQuestion", async () => {
    type CanUseToolFn = (toolName: string, input: Record<string, unknown>) => Promise<unknown>;
    let capturedCanUseTool: CanUseToolFn | undefined;

    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: { options: { canUseTool?: CanUseToolFn } }) => {
        capturedCanUseTool = opts.options.canUseTool;
        return createMockQuery([
          {
            type: "system",
            subtype: "init",
            session_id: "s5",
            tools: ["AskUserQuestion"],
            model: "claude-haiku-4-5",
          },
          {
            type: "result",
            subtype: "success",
            session_id: "s5",
            stop_reason: "end_turn",
            is_error: false,
            num_turns: 1,
            total_cost_usd: 0.001,
            duration_ms: 3000,
            usage: { input_tokens: 100, output_tokens: 50 },
            result: "Done",
          },
        ]);
      },
    );

    await runSession(minConfig());

    // Verify canUseTool was passed to query
    expect(capturedCanUseTool).toBeDefined();
    if (!capturedCanUseTool) throw new Error("capturedCanUseTool not set");

    // Non-AskUserQuestion tools should be allowed
    const allowResult = (await capturedCanUseTool("Read", {})) as { behavior: string };
    expect(allowResult.behavior).toBe("allow");
  });

  it("denies AskUserQuestion with malformed input", async () => {
    type CanUseToolFn = (toolName: string, input: Record<string, unknown>) => Promise<unknown>;
    let capturedCanUseTool: CanUseToolFn | undefined;

    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: { options: { canUseTool?: CanUseToolFn } }) => {
        capturedCanUseTool = opts.options.canUseTool;
        return createMockQuery([
          {
            type: "system",
            subtype: "init",
            session_id: "s6",
            tools: ["AskUserQuestion"],
            model: "claude-haiku-4-5",
          },
          {
            type: "result",
            subtype: "success",
            session_id: "s6",
            stop_reason: "end_turn",
            is_error: false,
            num_turns: 1,
            total_cost_usd: 0.001,
            duration_ms: 3000,
            usage: { input_tokens: 100, output_tokens: 50 },
            result: "Done",
          },
        ]);
      },
    );

    await runSession(minConfig());
    expect(capturedCanUseTool).toBeDefined();
    if (!capturedCanUseTool) throw new Error("capturedCanUseTool not set");

    // Malformed AskUserQuestion input should be denied
    const denyResult = (await capturedCanUseTool("AskUserQuestion", { garbage: true })) as {
      behavior: string;
    };
    expect(denyResult.behavior).toBe("deny");
  });

  it("handles timeout with exit code 6", async () => {
    // Create a query that hangs until interrupt() is called
    let resolveHang: (() => void) | undefined;
    const neverEndingQuery = {
      close: vi.fn(),
      interrupt: vi.fn(async () => {
        resolveHang?.();
      }),
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "s-timeout",
          tools: [],
          model: "claude-haiku-4-5",
        };
        await new Promise<void>((resolve) => {
          resolveHang = resolve;
        });
      },
    };

    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(neverEndingQuery);

    const config = minConfig();
    // Use a very short timeout for testing
    const result = await runSession(config, { timeoutSeconds: 0.1 });

    expect(result.exitCode).toBe(6);
    expect(neverEndingQuery.close).toHaveBeenCalled();
  });

  it("swallows interrupt() rejection on timeout", async () => {
    let resolveHang: (() => void) | undefined;
    const mockQuery = {
      close: vi.fn(),
      interrupt: vi.fn(async () => {
        resolveHang?.();
        throw new Error("interrupt failed");
      }),
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "s-int-reject",
          tools: [],
          model: "claude-haiku-4-5",
        };
        await new Promise<void>((resolve) => {
          resolveHang = resolve;
        });
      },
    };

    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

    const result = await runSession(minConfig(), { timeoutSeconds: 0.1 });
    expect(result.exitCode).toBe(6);
    expect(mockQuery.interrupt).toHaveBeenCalled();
  });

  it("swallows interrupt() rejection and exits 130 when external signal aborts mid-iteration", async () => {
    const mockQuery = {
      close: vi.fn(),
      interrupt: vi.fn().mockRejectedValue(new Error("interrupt failed")),
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "s-sigabort",
          tools: [],
          model: "claude-haiku-4-5",
        };
        // Reject after the signal fires, forcing the for-await into the outer catch
        await new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error("aborted")), 50);
        });
      },
    };

    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

    const signalController = new AbortController();
    setTimeout(() => signalController.abort(), 30);

    const result = await runSession(minConfig(), { signal: signalController.signal });
    expect(result.exitCode).toBe(130);
    expect(mockQuery.interrupt).toHaveBeenCalled();
  });

  it("passes env to query() with CLAUDECODE unset and does not mutate process.env", async () => {
    process.env.CLAUDECODE = "from-parent";
    process.env.SCUTTLERUN_TEST_VAR = "preserved";

    let capturedOptions: Record<string, unknown> | undefined;
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: Record<string, Record<string, unknown>>) => {
        capturedOptions = opts.options;
        return createMockQuery([
          {
            type: "system",
            subtype: "init",
            session_id: "s6",
            tools: [],
            model: "claude-haiku-4-5",
          },
          {
            type: "result",
            subtype: "success",
            session_id: "s6",
            stop_reason: "end_turn",
            is_error: false,
            num_turns: 1,
            total_cost_usd: 0.001,
            duration_ms: 1000,
            usage: { input_tokens: 50, output_tokens: 20 },
            result: "Done",
          },
        ]);
      },
    );

    await runSession(
      minConfig({
        sandbox: {
          enabled: false,
          network: { allowed_domains: [], allow_local_binding: false },
          filesystem: { deny_read: [], allow_write: [], deny_write: [] },
        },
      }),
    );

    // Non-mutation: parent process.env is preserved
    expect(process.env.CLAUDECODE).toBe("from-parent");
    expect(process.env.SCUTTLERUN_TEST_VAR).toBe("preserved");

    // Per-call: SDK options.env strips CLAUDECODE while preserving other vars
    const env = capturedOptions?.env as Record<string, string | undefined>;
    expect(env).toBeDefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.SCUTTLERUN_TEST_VAR).toBe("preserved");

    delete process.env.CLAUDECODE;
    delete process.env.SCUTTLERUN_TEST_VAR;
  });

  it("sets HOME to sandbox home dir when sandbox is enabled", async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: Record<string, Record<string, unknown>>) => {
        capturedOptions = opts.options;
        return createMockQuery([
          {
            type: "system",
            subtype: "init",
            session_id: "s-sandbox-home",
            tools: [],
            model: "claude-haiku-4-5",
          },
          {
            type: "result",
            subtype: "success",
            session_id: "s-sandbox-home",
            stop_reason: "end_turn",
            is_error: false,
            num_turns: 1,
            total_cost_usd: 0.001,
            duration_ms: 1000,
            usage: { input_tokens: 50, output_tokens: 20 },
            result: "Done",
          },
        ]);
      },
    );

    await runSession(minConfig());

    const env = capturedOptions?.env as Record<string, string>;
    expect(env).toBeDefined();
    expect(env.HOME).toBe("/tmp/scuttlerun-project-test123/.home");
  });

  it("inherits process.env with CLAUDECODE cleared when sandbox is disabled and no sdk.env", async () => {
    process.env.SCUTTLERUN_INHERIT_TEST = "inherited-value";

    let capturedOptions: Record<string, unknown> | undefined;

    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: Record<string, Record<string, unknown>>) => {
        capturedOptions = opts.options;
        return createMockQuery([
          {
            type: "system",
            subtype: "init",
            session_id: "s-no-sandbox",
            tools: [],
            model: "claude-haiku-4-5",
          },
          {
            type: "result",
            subtype: "success",
            session_id: "s-no-sandbox",
            stop_reason: "end_turn",
            is_error: false,
            num_turns: 1,
            total_cost_usd: 0.001,
            duration_ms: 1000,
            usage: { input_tokens: 50, output_tokens: 20 },
            result: "Done",
          },
        ]);
      },
    );

    await runSession(
      minConfig({
        sandbox: {
          enabled: false,
          network: { allowed_domains: [], allow_local_binding: false },
          filesystem: {
            deny_read: [],
            allow_write: [],
            deny_write: [],
          },
        },
      }),
    );

    const env = capturedOptions?.env as Record<string, string | undefined>;
    expect(env).toBeDefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.SCUTTLERUN_INHERIT_TEST).toBe("inherited-value");

    delete process.env.SCUTTLERUN_INHERIT_TEST;
  });

  it("prints tool use blocks from assistant messages", async () => {
    const mockQuery = createMockQuery([
      {
        type: "system",
        subtype: "init",
        session_id: "s-tools",
        tools: [],
        model: "claude-haiku-4-5",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I'll write a file." },
            {
              type: "tool_use",
              id: "tu-1",
              name: "Write",
              input: { file_path: "/tmp/ocean.txt", content: "waves" },
            },
            {
              type: "tool_use",
              id: "tu-2",
              name: "Edit",
              input: { file_path: "/tmp/shore.txt", old_string: "a", new_string: "b" },
            },
            { type: "tool_use", id: "tu-3", name: "Read", input: { file_path: "/tmp/sky.txt" } },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "s-tools",
        stop_reason: "end_turn",
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.001,
        duration_ms: 3000,
        usage: { input_tokens: 100, output_tokens: 50 },
        result: "Done",
      },
    ]);

    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);
    await runSession(minConfig());

    expect(stdoutOutput).toContain("- tool: Write");
    expect(stdoutOutput).toContain("path: /tmp/ocean.txt");
    // Footer should count all tool calls
    expect(stdoutOutput).toContain("tool_calls: 3");
    // Footer should list files by operation
    expect(stdoutOutput).toContain("files_written:");
    expect(stdoutOutput).toContain("  - /tmp/ocean.txt");
    expect(stdoutOutput).toContain("files_edited:");
    expect(stdoutOutput).toContain("  - /tmp/shore.txt");
    expect(stdoutOutput).toContain("files_read:");
    expect(stdoutOutput).toContain("  - /tmp/sky.txt");
  });

  it("handles assistant message with no content", async () => {
    const mockQuery = createMockQuery([
      {
        type: "system",
        subtype: "init",
        session_id: "s-no-content",
        tools: [],
        model: "claude-haiku-4-5",
      },
      {
        type: "assistant",
        message: { role: "assistant", content: undefined },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "s-no-content",
        num_turns: 1,
        total_cost_usd: 0,
      },
    ]);
    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);
    const result = await runSession(minConfig());
    expect(result.exitCode).toBe(0);
  });

  it("counts non-tracked tools without recording file paths", async () => {
    const mockQuery = createMockQuery([
      {
        type: "system",
        subtype: "init",
        session_id: "s-bash",
        tools: [],
        model: "claude-haiku-4-5",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: { command: "echo hi" } }],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "s-bash",
        num_turns: 1,
        total_cost_usd: 0,
      },
    ]);
    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);
    await runSession(minConfig());
    expect(stdoutOutput).toContain("tool_calls: 1");
    expect(stdoutOutput).not.toContain("files_written:");
    expect(stdoutOutput).not.toContain("files_read:");
  });

  it("ignores unknown message types gracefully", async () => {
    const mockQuery = createMockQuery([
      {
        type: "system",
        subtype: "init",
        session_id: "s-unknown",
        tools: [],
        model: "claude-haiku-4-5",
      },
      { type: "tool_result", tool_use_id: "tu-1", content: "ok" },
      {
        type: "result",
        subtype: "success",
        session_id: "s-unknown",
        num_turns: 1,
        total_cost_usd: 0,
      },
    ]);
    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);
    const result = await runSession(minConfig());
    expect(result.exitCode).toBe(0);
  });

  it("skips tool_use blocks with no name", async () => {
    const mockQuery = createMockQuery([
      {
        type: "system",
        subtype: "init",
        session_id: "s-noname",
        tools: [],
        model: "claude-haiku-4-5",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu-1", name: "", input: {} },
            { type: "text", text: "Done." },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "s-noname",
        num_turns: 1,
        total_cost_usd: 0,
      },
    ]);
    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);
    await runSession(minConfig());
    expect(stdoutOutput).toContain("Done.");
    expect(stdoutOutput).toContain("tool_calls: 0");
  });

  it("logs verbose output when scaffolding a project", async () => {
    const mockQuery = createMockQuery([
      {
        type: "system",
        subtype: "init",
        session_id: "s-verbose-project",
        tools: [],
        model: "claude-haiku-4-5",
      },
      {
        type: "result",
        subtype: "success",
        session_id: "s-verbose-project",
        num_turns: 1,
        total_cost_usd: 0,
      },
    ]);
    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

    let stderrOutput = "";
    const origStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrOutput += chunk;
      return true;
    }) as typeof process.stderr.write;

    try {
      await runSession(minConfig({ project: { claude_md: "test", git_init: false } }), {
        verbose: true,
      });
      expect(stderrOutput).toContain("[scuttlerun] Scaffolded project at");
    } finally {
      process.stderr.write = origStderrWrite;
    }
  });

  it("passes verbose stderr callback that writes to stderr", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: Record<string, Record<string, unknown>>) => {
        capturedOptions = opts.options;
        return createMockQuery([
          {
            type: "system",
            subtype: "init",
            session_id: "s-stderr",
            tools: [],
            model: "claude-haiku-4-5",
          },
          {
            type: "result",
            subtype: "success",
            session_id: "s-stderr",
            num_turns: 1,
            total_cost_usd: 0,
          },
        ]);
      },
    );

    let stderrOutput = "";
    const origStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrOutput += chunk;
      return true;
    }) as typeof process.stderr.write;

    try {
      await runSession(minConfig(), { verbose: true });
      // Invoke the captured stderr callback to cover the function body
      const stderrFn = capturedOptions?.stderr as (data: string) => void;
      expect(stderrFn).toBeTypeOf("function");
      stderrFn("test stderr data");
      expect(stderrOutput).toContain("test stderr data");
    } finally {
      process.stderr.write = origStderrWrite;
    }
  });

  it("sets sdk.env when sandbox is disabled but sdk.env is provided", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: Record<string, Record<string, unknown>>) => {
        capturedOptions = opts.options;
        return createMockQuery([
          {
            type: "system",
            subtype: "init",
            session_id: "s-env",
            tools: [],
            model: "claude-haiku-4-5",
          },
          {
            type: "result",
            subtype: "success",
            session_id: "s-env",
            num_turns: 1,
            total_cost_usd: 0,
          },
        ]);
      },
    );

    await runSession(
      minConfig({
        sandbox: {
          enabled: false,
          network: { allowed_domains: [], allow_local_binding: false },
          filesystem: { deny_read: [], allow_write: [], deny_write: [] },
        },
        sdk: {
          system_prompt: { preset: "claude_code" as const },
          env: { FOO: "bar" },
          setting_sources: [],
        },
      }),
    );

    expect(capturedOptions?.env).toEqual({ FOO: "bar" });
  });

  it("writes thinking blocks from assistant messages", async () => {
    const mockQuery = createMockQuery([
      {
        type: "system",
        subtype: "init",
        session_id: "s-thinking",
        tools: [],
        model: "claude-haiku-4-5",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me consider this..." },
            { type: "text", text: "Done." },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "s-thinking",
        num_turns: 1,
        total_cost_usd: 0,
      },
    ]);

    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);
    await runSession(minConfig());

    expect(stdoutOutput).toContain("- thinking:");
    expect(stdoutOutput).toContain("Let me consider this...");
  });

  it("handles multi-turn reactive flow with continue then end", async () => {
    // Oracle returns "continue" for first turn, then "end" for second
    mockParse
      .mockResolvedValueOnce({
        parsed_output: {
          decision: "continue",
          message: "Please add tests",
          reasoning: "Task incomplete",
        },
        usage: { input_tokens: 100, output_tokens: 50 },
      })
      .mockResolvedValueOnce({
        parsed_output: { decision: "end", reasoning: "All done" },
        usage: { input_tokens: 100, output_tokens: 50 },
      });

    // Use a mock that consumes the inputGenerator to cover the multi-turn
    // generator code (lines 99-115 in runner.ts)
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: { prompt: AsyncGenerator; options: Record<string, unknown> }) => {
        const inputGen = opts.prompt;
        return {
          close: vi.fn(),
          interrupt: vi.fn().mockResolvedValue(undefined),
          [Symbol.asyncIterator]: async function* () {
            // Consume initial prompt from generator
            await inputGen.next();

            // Kick off the generator's while loop (waits for resolveNextAction)
            const pendingContinue = inputGen.next();

            yield {
              type: "system",
              subtype: "init",
              session_id: "s-multi",
              tools: [],
              model: "claude-haiku-4-5",
            };
            yield {
              type: "assistant",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Here is the code." }],
              },
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "s-multi",
              num_turns: 1,
              total_cost_usd: 0.01,
            };
            // Runner processes result → decideTurn → "continue" → resolveNextAction

            // Generator yields follow-up message
            const continueResult = await pendingContinue;
            expect(continueResult.done).toBe(false);

            // Kick off next iteration of generator (waits for resolveNextAction)
            const pendingEnd = inputGen.next();

            yield {
              type: "assistant",
              message: { role: "assistant", content: [{ type: "text", text: "Tests added." }] },
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "s-multi",
              num_turns: 2,
              total_cost_usd: 0.02,
            };
            // Runner processes result → decideTurn → "end" → resolveNextAction({ type: "end" })

            // Generator returns (done: true)
            const endResult = await pendingEnd;
            expect(endResult.done).toBe(true);
          },
        };
      },
    );

    const result = await runSession(
      minConfig({
        user: { oracle_model: "claude-haiku-4-5", max_turns: 5 },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(stdoutOutput).toContain("oracle: turn");
    expect(stdoutOutput).toContain("Please add tests");
  });

  it("does not emit oracle_turn transcript entry on cap-driven termination", async () => {
    // Oracle returns "continue" for the first decideTurn. After that the
    // synthetic user's userTurnCount equals max_turns (1), so the second
    // decideTurn short-circuits on the cap and never contacts the oracle.
    // Per spec rule TurnPolicyEndsByCap, no oracle_turn transcript entry
    // is emitted on the cap-driven path.
    mockParse.mockResolvedValueOnce({
      parsed_output: { decision: "continue", message: "Add tests", reasoning: "Task incomplete" },
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: { prompt: AsyncGenerator; options: Record<string, unknown> }) => {
        const inputGen = opts.prompt;
        return {
          close: vi.fn(),
          interrupt: vi.fn().mockResolvedValue(undefined),
          [Symbol.asyncIterator]: async function* () {
            await inputGen.next();
            const pendingContinue = inputGen.next();

            yield {
              type: "system",
              subtype: "init",
              session_id: "s-cap",
              tools: [],
              model: "claude-haiku-4-5",
            };
            yield {
              type: "assistant",
              message: { role: "assistant", content: [{ type: "text", text: "First answer." }] },
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "s-cap",
              num_turns: 1,
              total_cost_usd: 0.01,
            };

            const continueResult = await pendingContinue;
            expect(continueResult.done).toBe(false);

            const pendingEnd = inputGen.next();

            yield {
              type: "assistant",
              message: { role: "assistant", content: [{ type: "text", text: "Second answer." }] },
            };
            yield {
              type: "result",
              subtype: "success",
              session_id: "s-cap",
              num_turns: 2,
              total_cost_usd: 0.02,
            };

            const endResult = await pendingEnd;
            expect(endResult.done).toBe(true);
          },
        };
      },
    );

    const result = await runSession(
      minConfig({
        user: { oracle_model: "claude-haiku-4-5", max_turns: 1 },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(mockParse).toHaveBeenCalledTimes(1);
    const oracleTurnMatches = stdoutOutput.match(/oracle: turn/g) ?? [];
    expect(oracleTurnMatches).toHaveLength(1);
  });

  it("handles canUseTool AskUserQuestion via oracle", async () => {
    type CanUseToolFn = (toolName: string, input: Record<string, unknown>) => Promise<unknown>;

    // Mock oracle answer for AskUserQuestion
    mockParse.mockResolvedValueOnce({
      parsed_output: {
        answers: [{ question: "What language?", answer: "TypeScript" }],
        reasoning: "User prefers TS",
      },
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    let capturedCanUseTool: CanUseToolFn | undefined;
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: { options: { canUseTool?: CanUseToolFn } }) => {
        capturedCanUseTool = opts.options.canUseTool;
        return {
          close: vi.fn(),
          interrupt: vi.fn().mockResolvedValue(undefined),
          [Symbol.asyncIterator]: async function* () {
            yield {
              type: "system",
              subtype: "init",
              session_id: "s-ask",
              tools: ["AskUserQuestion"],
              model: "claude-haiku-4-5",
            };
            // After init, syntheticUser is created — call canUseTool
            if (!capturedCanUseTool) throw new Error("capturedCanUseTool not set");
            const askResult = (await capturedCanUseTool("AskUserQuestion", {
              questions: [
                {
                  question: "What language?",
                  header: "Language",
                  options: [
                    { label: "TypeScript", description: "TS" },
                    { label: "Python", description: "Py" },
                  ],
                  multiSelect: false,
                },
              ],
            })) as { behavior: string; updatedInput: { answers: Record<string, string> } };
            expect(askResult.behavior).toBe("allow");
            expect(askResult.updatedInput.answers["What language?"]).toBe("TypeScript");
            yield {
              type: "result",
              subtype: "success",
              session_id: "s-ask",
              num_turns: 1,
              total_cost_usd: 0,
            };
          },
        };
      },
    );

    await runSession(minConfig());

    expect(stdoutOutput).toContain("oracle: ask_user");
    expect(stdoutOutput).toContain("TypeScript");
  });

  it("denies tool use, writes oracle error, and exits 2 when handleAskUserQuestion throws a non-Error", async () => {
    type CanUseToolFn = (toolName: string, input: Record<string, unknown>) => Promise<unknown>;

    const { SyntheticUser } = await import("../src/synthetic-user.js");
    const spy = vi
      .spyOn(SyntheticUser.prototype, "handleAskUserQuestion")
      .mockRejectedValueOnce("string-error-from-oracle");

    let capturedCanUseTool: CanUseToolFn | undefined;
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: { options: { canUseTool?: CanUseToolFn } }) => {
        capturedCanUseTool = opts.options.canUseTool;
        return {
          close: vi.fn(),
          interrupt: vi.fn().mockResolvedValue(undefined),
          [Symbol.asyncIterator]: async function* () {
            yield {
              type: "system",
              subtype: "init",
              session_id: "s-oracle-str",
              tools: ["AskUserQuestion"],
              model: "claude-haiku-4-5",
            };
            if (!capturedCanUseTool) throw new Error("capturedCanUseTool not set");
            await capturedCanUseTool("AskUserQuestion", {
              questions: [
                {
                  question: "Q?",
                  header: "H",
                  options: [
                    { label: "A", description: "a" },
                    { label: "B", description: "b" },
                  ],
                  multiSelect: false,
                },
              ],
            });
            yield {
              type: "result",
              subtype: "success",
              session_id: "s-oracle-str",
              num_turns: 1,
              total_cost_usd: 0,
            };
          },
        };
      },
    );

    const result = await runSession(minConfig());

    expect(stdoutOutput).toContain("oracle: error");
    expect(stdoutOutput).toContain("string-error-from-oracle");
    expect(result.exitCode).toBe(2);

    spy.mockRestore();
  });

  it("denies tool use, writes oracle error, and exits 2 when handleAskUserQuestion throws", async () => {
    type CanUseToolFn = (toolName: string, input: Record<string, unknown>) => Promise<unknown>;

    // Make the oracle throw on the first call. Spy on the prototype so the
    // runner-constructed SyntheticUser instance picks up the rejection.
    const { SyntheticUser } = await import("../src/synthetic-user.js");
    const spy = vi
      .spyOn(SyntheticUser.prototype, "handleAskUserQuestion")
      .mockRejectedValueOnce(new Error("Oracle exhausted 4 attempts: network down"));

    let capturedCanUseTool: CanUseToolFn | undefined;
    let askResult: { behavior: string } | undefined;
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: { options: { canUseTool?: CanUseToolFn } }) => {
        capturedCanUseTool = opts.options.canUseTool;
        return {
          close: vi.fn(),
          interrupt: vi.fn().mockResolvedValue(undefined),
          [Symbol.asyncIterator]: async function* () {
            yield {
              type: "system",
              subtype: "init",
              session_id: "s-oracle-fail",
              tools: ["AskUserQuestion"],
              model: "claude-haiku-4-5",
            };
            if (!capturedCanUseTool) throw new Error("capturedCanUseTool not set");
            askResult = (await capturedCanUseTool("AskUserQuestion", {
              questions: [
                {
                  question: "What language?",
                  header: "Language",
                  options: [
                    { label: "TypeScript", description: "TS" },
                    { label: "Python", description: "Py" },
                  ],
                  multiSelect: false,
                },
              ],
            })) as { behavior: string };
            yield {
              type: "result",
              subtype: "success",
              session_id: "s-oracle-fail",
              num_turns: 1,
              total_cost_usd: 0,
            };
          },
        };
      },
    );

    const result = await runSession(minConfig());

    expect(askResult?.behavior).toBe("deny");
    expect(stdoutOutput).toContain("oracle: error");
    expect(stdoutOutput).toContain("Oracle exhausted 4 attempts: network down");
    expect(result.exitCode).toBe(2);

    spy.mockRestore();
  });

  it("returns exit code 2 when query throws a non-timeout error", async () => {
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("SDK crash");
    });

    const result = await runSession(minConfig());
    expect(result.exitCode).toBe(2);
  });

  it("returns exit code 6 when query throws after timeout", async () => {
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(() => {
      // Simulate: timeout fires, then error is thrown
      return {
        close: vi.fn(),
        interrupt: vi.fn().mockResolvedValue(undefined),
        [Symbol.asyncIterator]: async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "s-throw-timeout",
            tools: [],
            model: "claude-haiku-4-5",
          };
          // Wait for timeout to fire, then throw
          await new Promise<void>((resolve) => setTimeout(resolve, 150));
          throw new Error("aborted");
        },
      };
    });

    const result = await runSession(minConfig(), { timeoutSeconds: 0.1 });
    expect(result.exitCode).toBe(6);
  });

  it("handles timeout during oracle decideTurn (catch with timedOut)", async () => {
    // Oracle call takes longer than timeout, then throws
    mockParse.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      throw new Error("oracle timed out");
    });

    const mockQuery = createMockQuery([
      {
        type: "system",
        subtype: "init",
        session_id: "s-catch-timeout",
        tools: [],
        model: "claude-haiku-4-5",
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Code." }] },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "s-catch-timeout",
        num_turns: 1,
        total_cost_usd: 0,
      },
    ]);
    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

    const result = await runSession(
      minConfig({ user: { oracle_model: "claude-haiku-4-5", max_turns: 5 } }),
      { timeoutSeconds: 0.05 },
    );
    // Timeout fires during oracle call, oracle then throws → catch with timedOut=true
    expect(result.exitCode).toBe(6);
  });

  it("handles already-aborted signal on next loop iteration", async () => {
    // Oracle call takes longer than timeout but succeeds (doesn't throw)
    mockParse.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        parsed_output: { decision: "continue", message: "more", reasoning: "not done" },
        usage: { input_tokens: 50, output_tokens: 20 },
      };
    });

    const mockQuery = createMockQuery([
      {
        type: "system",
        subtype: "init",
        session_id: "s-already-aborted",
        tools: [],
        model: "claude-haiku-4-5",
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "s-already-aborted",
        num_turns: 1,
        total_cost_usd: 0,
      },
      // More messages that won't be consumed due to timeout
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "More." }] },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "s-already-aborted",
        num_turns: 2,
        total_cost_usd: 0,
      },
    ]);
    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

    const result = await runSession(
      minConfig({ user: { oracle_model: "claude-haiku-4-5", max_turns: 5 } }),
      { timeoutSeconds: 0.05 },
    );
    // Timeout fires during oracle call. Oracle completes with "continue".
    // Loop re-enters → abortPromise sees already-aborted signal → breaks.
    expect(result.exitCode).toBe(6);
  });

  it("handles error result after generator is consumed (resolveNextAction defined)", async () => {
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: { prompt: AsyncGenerator; options: Record<string, unknown> }) => {
        const inputGen = opts.prompt;
        return {
          close: vi.fn(),
          interrupt: vi.fn().mockResolvedValue(undefined),
          [Symbol.asyncIterator]: async function* () {
            // Consume initial prompt
            await inputGen.next();
            // Start generator's while loop (sets resolveNextAction)
            const pending = inputGen.next();

            yield {
              type: "system",
              subtype: "init",
              session_id: "s-err-gen",
              tools: [],
              model: "claude-haiku-4-5",
            };
            yield {
              type: "result",
              subtype: "error_during_execution",
              session_id: "s-err-gen",
              is_error: true,
              errors: ["boom"],
            };
            // resolveNextAction?.() is now called with resolveNextAction DEFINED → covers the branch

            // Generator should end (resolveNextAction called with "end")
            const result = await pending;
            expect(result.done).toBe(true);
          },
        };
      },
    );

    const result = await runSession(minConfig());
    expect(result.exitCode).toBe(2);
  });

  it("fails fast with exit code 2 when HOME is unset and sandbox is disabled", async () => {
    const origHome = process.env.HOME;
    delete process.env.HOME;

    try {
      const mockQuery = createMockQuery([
        {
          type: "system",
          subtype: "init",
          session_id: "s-nohome",
          tools: [],
          model: "claude-haiku-4-5",
        },
        {
          type: "result",
          subtype: "success",
          session_id: "s-nohome",
          num_turns: 1,
          total_cost_usd: 0,
        },
      ]);
      (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

      const result = await runSession(
        minConfig({
          sandbox: {
            enabled: false,
            network: { allowed_domains: [], allow_local_binding: false },
            filesystem: { deny_read: [], allow_write: [], deny_write: [] },
          },
        }),
      );

      expect(result.exitCode).toBe(2);
    } finally {
      process.env.HOME = origHome;
    }
  });

  it("passes optional SDK config fields when set", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: Record<string, Record<string, unknown>>) => {
        capturedOptions = opts.options;
        return createMockQuery([
          {
            type: "system",
            subtype: "init",
            session_id: "s-opts",
            tools: [],
            model: "claude-haiku-4-5",
          },
          {
            type: "result",
            subtype: "success",
            session_id: "s-opts",
            num_turns: 1,
            total_cost_usd: 0,
          },
        ]);
      },
    );

    await runSession(
      minConfig({
        max_budget_usd: 5.0,
        disallowed_tools: ["Agent"],
        sdk: {
          system_prompt: "Be concise",
          thinking: { type: "adaptive" },
          mcp_servers: { test: { command: "node", args: ["server.js"] } },
          agents: { helper: { description: "helper agent", prompt: "be helpful" } },
          setting_sources: ["project"],
        },
      }),
    );

    expect(capturedOptions?.maxBudgetUsd).toBe(5.0);
    expect(capturedOptions?.systemPrompt).toEqual(["Be concise", SYSTEM_PROMPT_DYNAMIC_BOUNDARY]);
    expect(capturedOptions?.disallowedTools).toEqual(["Agent"]);
    expect(capturedOptions?.thinking).toEqual({ type: "adaptive" });
    expect(capturedOptions?.mcpServers).toEqual({ test: { command: "node", args: ["server.js"] } });
    expect(capturedOptions?.agents).toEqual({
      helper: { description: "helper agent", prompt: "be helpful" },
    });
  });

  it("wraps custom string systemPrompt in [string, SYSTEM_PROMPT_DYNAMIC_BOUNDARY] for prompt caching", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: Record<string, Record<string, unknown>>) => {
        capturedOptions = opts.options;
        return createMockQuery([
          {
            type: "system",
            subtype: "init",
            session_id: "s-cache",
            tools: [],
            model: "claude-haiku-4-5",
          },
          {
            type: "result",
            subtype: "success",
            session_id: "s-cache",
            num_turns: 1,
            total_cost_usd: 0,
          },
        ]);
      },
    );

    await runSession(
      minConfig({
        sdk: {
          system_prompt: "Be concise",
          setting_sources: [],
        },
      }),
    );

    expect(capturedOptions?.systemPrompt).toEqual(["Be concise", SYSTEM_PROMPT_DYNAMIC_BOUNDARY]);
  });

  it("resolves sdk.plugins paths and forwards them to query", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: Record<string, Record<string, unknown>>) => {
        capturedOptions = opts.options;
        return createMockQuery([
          {
            type: "system",
            subtype: "init",
            session_id: "s-plugins",
            tools: [],
            model: "claude-haiku-4-5",
          },
          {
            type: "result",
            subtype: "success",
            session_id: "s-plugins",
            num_turns: 1,
            total_cost_usd: 0,
          },
        ]);
      },
    );

    await runSession(
      minConfig({
        sdk: {
          system_prompt: { preset: "claude_code" as const },
          plugins: [{ type: "local", path: "~/my-plugin" }],
          setting_sources: [],
        },
      }),
      { configDir: "/tmp/cfg" },
    );

    expect(mockResolveSkillPath).toHaveBeenCalledWith("~/my-plugin", "/tmp/cfg");
    expect(capturedOptions?.plugins).toEqual([{ type: "local", path: "~/my-plugin" }]);
  });

  it("falls back to process.cwd() for plugin resolution when configDir is omitted", async () => {
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(() => {
      return createMockQuery([
        {
          type: "system",
          subtype: "init",
          session_id: "s-plugins-cwd",
          tools: [],
          model: "claude-haiku-4-5",
        },
        {
          type: "result",
          subtype: "success",
          session_id: "s-plugins-cwd",
          num_turns: 1,
          total_cost_usd: 0,
        },
      ]);
    });

    await runSession(
      minConfig({
        sdk: {
          system_prompt: { preset: "claude_code" as const },
          plugins: [{ type: "local", path: "./rel" }],
          setting_sources: [],
        },
      }),
      // no configDir — forces options.configDir || process.cwd() to take the right side
    );

    expect(mockResolveSkillPath).toHaveBeenCalledWith("./rel", process.cwd());
  });

  it("passes claude_code preset as default systemPrompt", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: Record<string, Record<string, unknown>>) => {
        capturedOptions = opts.options;
        return createMockQuery([
          {
            type: "system",
            subtype: "init",
            session_id: "s-preset",
            tools: [],
            model: "claude-haiku-4-5",
          },
          {
            type: "result",
            subtype: "success",
            session_id: "s-preset",
            num_turns: 1,
            total_cost_usd: 0,
          },
        ]);
      },
    );

    await runSession(minConfig());

    expect(capturedOptions?.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
    });
  });

  it("passes preset with append when configured", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: Record<string, Record<string, unknown>>) => {
        capturedOptions = opts.options;
        return createMockQuery([
          {
            type: "system",
            subtype: "init",
            session_id: "s-append",
            tools: [],
            model: "claude-haiku-4-5",
          },
          {
            type: "result",
            subtype: "success",
            session_id: "s-append",
            num_turns: 1,
            total_cost_usd: 0,
          },
        ]);
      },
    );

    await runSession(
      minConfig({
        sdk: {
          system_prompt: { preset: "claude_code" as const, append: "Be brief." },
          setting_sources: [],
        },
      }),
    );

    expect(capturedOptions?.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "Be brief.",
    });
  });

  it("filters sandbox env to only safe vars from process.env", async () => {
    const origAwsKey = process.env.AWS_SECRET_ACCESS_KEY;
    const origGhToken = process.env.GITHUB_TOKEN;
    try {
      process.env.AWS_SECRET_ACCESS_KEY = "FAKE_SECRET";
      process.env.GITHUB_TOKEN = "ghp_fake";

      let capturedOptions: Record<string, unknown> | undefined;
      (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
        (opts: Record<string, Record<string, unknown>>) => {
          capturedOptions = opts.options;
          return createMockQuery([
            {
              type: "system",
              subtype: "init",
              session_id: "s-env-filter",
              tools: [],
              model: "claude-haiku-4-5",
            },
            {
              type: "result",
              subtype: "success",
              session_id: "s-env-filter",
              num_turns: 1,
              total_cost_usd: 0,
            },
          ]);
        },
      );

      await runSession(minConfig());

      const env = capturedOptions?.env as Record<string, string>;
      expect(env).toBeDefined();
      expect(env.HOME).toBe("/tmp/scuttlerun-project-test123/.home");
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      // Safe vars from process.env should be present
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      if (origAwsKey === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = origAwsKey;
      if (origGhToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = origGhToken;
    }
  });

  it("includes sdk.env vars in sandbox filtered env", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: Record<string, Record<string, unknown>>) => {
        capturedOptions = opts.options;
        return createMockQuery([
          {
            type: "system",
            subtype: "init",
            session_id: "s-sdk-env-merge",
            tools: [],
            model: "claude-haiku-4-5",
          },
          {
            type: "result",
            subtype: "success",
            session_id: "s-sdk-env-merge",
            num_turns: 1,
            total_cost_usd: 0,
          },
        ]);
      },
    );

    await runSession(
      minConfig({
        sdk: {
          system_prompt: { preset: "claude_code" as const },
          env: { CUSTOM_VAR: "custom" },
          setting_sources: [],
        },
      }),
    );

    const env = capturedOptions?.env as Record<string, string>;
    expect(env).toBeDefined();
    expect(env.CUSTOM_VAR).toBe("custom");
    expect(env.HOME).toBe("/tmp/scuttlerun-project-test123/.home");
  });

  it("returns exit code 130 when options.signal is aborted mid-session", async () => {
    mockParse.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        parsed_output: { decision: "continue", message: "more", reasoning: "ok" },
        usage: { input_tokens: 50, output_tokens: 20 },
      };
    });

    const mockQuery = createMockQuery([
      {
        type: "system",
        subtype: "init",
        session_id: "s-sigint-1",
        tools: [],
        model: "claude-haiku-4-5",
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Hi." }] },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "s-sigint-1",
        num_turns: 1,
        total_cost_usd: 0,
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "More." }] },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "s-sigint-1",
        num_turns: 2,
        total_cost_usd: 0,
      },
    ]);
    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

    const signalController = new AbortController();
    setTimeout(() => signalController.abort(), 30);

    const result = await runSession(
      minConfig({ user: { oracle_model: "claude-haiku-4-5", max_turns: 5 } }),
      { signal: signalController.signal },
    );

    expect(result.exitCode).toBe(130);
  });

  it("calls queryHandle.interrupt() when options.signal is aborted", async () => {
    mockParse.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        parsed_output: { decision: "continue", message: "m", reasoning: "ok" },
        usage: { input_tokens: 50, output_tokens: 20 },
      };
    });

    const interruptSpy = vi.fn().mockResolvedValue(undefined);
    const mockQuery = {
      close: vi.fn(),
      interrupt: interruptSpy,
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "s-sigint-2",
          tools: [],
          model: "claude-haiku-4-5",
        };
        yield {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "Hi." }] },
        };
        yield {
          type: "result",
          subtype: "success",
          session_id: "s-sigint-2",
          num_turns: 1,
          total_cost_usd: 0,
        };
      },
    };
    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

    const signalController = new AbortController();
    setTimeout(() => signalController.abort(), 30);

    await runSession(minConfig({ user: { oracle_model: "claude-haiku-4-5", max_turns: 5 } }), {
      signal: signalController.signal,
    });

    expect(interruptSpy).toHaveBeenCalled();
  });

  it("removes the signal listener after runSession returns", async () => {
    const mockQuery = createMockQuery([
      {
        type: "system",
        subtype: "init",
        session_id: "s-sigint-3",
        tools: [],
        model: "claude-haiku-4-5",
      },
      {
        type: "result",
        subtype: "success",
        session_id: "s-sigint-3",
        num_turns: 1,
        total_cost_usd: 0,
      },
    ]);
    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

    const signalController = new AbortController();
    const removeSpy = vi.spyOn(signalController.signal, "removeEventListener");

    await runSession(minConfig(), { signal: signalController.signal });

    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

// =============================================================================
// Spec-derived tests (from scuttlerun.allium via `allium plan`)
// Each test names the obligation it discharges in [bracket-prefix] style.
// =============================================================================

describe("scuttlerun.allium invariants and rule obligations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (mockCreateProjectDir as ReturnType<typeof vi.fn>).mockResolvedValue(
      "/tmp/scuttlerun-project-test123",
    );
    (mockScaffoldProject as ReturnType<typeof vi.fn>).mockResolvedValue({
      projectPath: "/tmp/scuttlerun-project-scaffold123",
    });
    (mockCleanOldProjects as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    stdoutOutput = "";
    process.stdout.write = ((chunk: string) => {
      stdoutOutput += chunk;
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
  });

  // -------------------------------------------------------------------------
  // [invariant.WorkspacePreservedAcrossOutcomes]
  // For session in Sessions: session.is_terminated implies exists session.workspace
  // -------------------------------------------------------------------------
  describe("[invariant] WorkspacePreservedAcrossOutcomes", () => {
    const terminalCases: Array<{ status: string; subtype: string; expectExit: number }> = [
      { status: "completed_success", subtype: "success", expectExit: 0 },
      { status: "exhausted_turns", subtype: "error_max_turns", expectExit: 7 },
      { status: "exhausted_budget", subtype: "error_max_budget_usd", expectExit: 5 },
      { status: "failed", subtype: "error_during_execution", expectExit: 2 },
    ];

    for (const { status, subtype, expectExit } of terminalCases) {
      it(`preserves workspace path on terminal status ${status}`, async () => {
        const mockQuery = createMockQuery([
          {
            type: "system",
            subtype: "init",
            session_id: `s-pres-${status}`,
            tools: [],
            model: "claude-haiku-4-5",
          },
          subtype === "success"
            ? {
                type: "result",
                subtype: "success",
                session_id: `s-pres-${status}`,
                num_turns: 1,
                total_cost_usd: 0,
              }
            : {
                type: "result",
                subtype,
                session_id: `s-pres-${status}`,
                is_error: true,
                num_turns: 1,
                total_cost_usd: 0,
                errors: ["x"],
              },
        ]);
        (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

        const result = await runSession(minConfig());

        expect(result.exitCode).toBe(expectExit);
        // Workspace was created exactly once (no re-creation, no destructive cleanup of this run's dir)
        expect(mockCreateProjectDir).toHaveBeenCalledTimes(1);
        expect(mockScaffoldProject).not.toHaveBeenCalled();
      });
    }

    it("preserves workspace path on terminal status timed_out", async () => {
      let resolveHang: (() => void) | undefined;
      const mockQuery = {
        close: vi.fn(),
        interrupt: vi.fn(async () => {
          resolveHang?.();
        }),
        [Symbol.asyncIterator]: async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "s-pres-timeout",
            tools: [],
            model: "claude-haiku-4-5",
          };
          await new Promise<void>((r) => {
            resolveHang = r;
          });
        },
      };
      (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

      const result = await runSession(minConfig(), { timeoutSeconds: 0.05 });

      expect(result.exitCode).toBe(6);
      expect(mockCreateProjectDir).toHaveBeenCalledTimes(1);
      expect(mockScaffoldProject).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // [invariant.OnlyTextReachesOracleContext]
  // For entry in ConversationEntries: entry.role in {user, assistant} and contains
  // only text. Tool uses, tool results and thinking blocks must be stripped before
  // the oracle is consulted.
  // -------------------------------------------------------------------------
  describe("[invariant] OnlyTextReachesOracleContext", () => {
    it("strips thinking and tool_use blocks before the oracle's decideTurn call", async () => {
      mockParse.mockResolvedValueOnce({
        parsed_output: { decision: "end", reasoning: "done" },
        usage: { input_tokens: 50, output_tokens: 20 },
      });

      const mockQuery = createMockQuery([
        {
          type: "system",
          subtype: "init",
          session_id: "s-text-only",
          tools: [],
          model: "claude-haiku-4-5",
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "INTERNAL_THINKING_MARKER must be hidden" },
              {
                type: "tool_use",
                id: "tu-1",
                name: "Write",
                input: { file_path: "/tmp/leak.txt", content: "TOOL_INPUT_MARKER" },
              },
              { type: "text", text: "VISIBLE_ASSISTANT_TEXT" },
            ],
          },
        },
        {
          type: "result",
          subtype: "success",
          session_id: "s-text-only",
          num_turns: 1,
          total_cost_usd: 0,
        },
      ]);
      (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

      await runSession(minConfig({ user: { oracle_model: "claude-haiku-4-5", max_turns: 5 } }));

      // The oracle.decideTurnPolicy call routes through mockParse. Inspect the
      // user message it received and verify only text content reaches it.
      expect(mockParse).toHaveBeenCalled();
      const callArgs = mockParse.mock.calls[0][0];
      const userMsg = callArgs.messages[0].content as string;
      expect(userMsg).toContain("VISIBLE_ASSISTANT_TEXT");
      expect(userMsg).not.toContain("INTERNAL_THINKING_MARKER");
      expect(userMsg).not.toContain("TOOL_INPUT_MARKER");
      expect(userMsg).not.toContain("/tmp/leak.txt");
    });
  });

  // -------------------------------------------------------------------------
  // [rule.SessionFinalises]
  // when: session: Session.is_terminated
  // ensures: session.transcript.finalized = true
  // ensures: AgentSdkClosed(session)
  // -------------------------------------------------------------------------
  describe("[rule] SessionFinalises", () => {
    const cases: Array<{ name: string; subtype: string; expectExit: number }> = [
      { name: "completed_success", subtype: "success", expectExit: 0 },
      { name: "exhausted_turns", subtype: "error_max_turns", expectExit: 7 },
      { name: "exhausted_budget", subtype: "error_max_budget_usd", expectExit: 5 },
      { name: "failed", subtype: "error_during_execution", expectExit: 2 },
    ];

    for (const { name, subtype, expectExit } of cases) {
      it(`closes the SDK query and emits the footer on ${name}`, async () => {
        const mockQuery = createMockQuery([
          {
            type: "system",
            subtype: "init",
            session_id: `s-fin-${name}`,
            tools: [],
            model: "claude-haiku-4-5",
          },
          subtype === "success"
            ? {
                type: "result",
                subtype: "success",
                session_id: `s-fin-${name}`,
                num_turns: 1,
                total_cost_usd: 0,
              }
            : {
                type: "result",
                subtype,
                session_id: `s-fin-${name}`,
                is_error: true,
                num_turns: 1,
                total_cost_usd: 0,
                errors: ["x"],
              },
        ]);
        (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

        const result = await runSession(minConfig());

        expect(result.exitCode).toBe(expectExit);
        expect(mockQuery.close).toHaveBeenCalledTimes(1);
        // Footer presence — keys appear in a finalised transcript only
        expect(stdoutOutput).toContain("turns:");
        expect(stdoutOutput).toContain("duration_s:");
      });
    }

    it("closes the SDK query and emits the footer on timed_out", async () => {
      let resolveHang: (() => void) | undefined;
      const mockQuery = {
        close: vi.fn(),
        interrupt: vi.fn(async () => {
          resolveHang?.();
        }),
        [Symbol.asyncIterator]: async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "s-fin-timeout",
            tools: [],
            model: "claude-haiku-4-5",
          };
          await new Promise<void>((r) => {
            resolveHang = r;
          });
        },
      };
      (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

      const result = await runSession(minConfig(), { timeoutSeconds: 0.05 });

      expect(result.exitCode).toBe(6);
      expect(mockQuery.close).toHaveBeenCalledTimes(1);
      expect(stdoutOutput).toContain("turns:");
      expect(stdoutOutput).toContain("duration_s:");
      expect(stdoutOutput).toContain("timed_out: true");
    });

    it("emits the footer when an unexpected exception is thrown mid-stream", async () => {
      // SDK iterator throws partway through the for-await loop, after init.
      // The transcript must still be finalised (footer emitted) on this path.
      const mockQuery = {
        close: vi.fn(),
        interrupt: vi.fn().mockResolvedValue(undefined),
        [Symbol.asyncIterator]: async function* () {
          yield {
            type: "system",
            subtype: "init",
            session_id: "s-fin-exception",
            tools: [],
            model: "claude-haiku-4-5",
          };
          throw new Error("unexpected SDK explosion");
        },
      };
      (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

      const result = await runSession(minConfig());

      // Exit code stays 2 for non-timeout exceptions
      expect(result.exitCode).toBe(2);
      // Footer-distinguishing keys must be present
      expect(stdoutOutput).toContain("turns:");
      expect(stdoutOutput).toContain("tool_calls:");
      expect(stdoutOutput).toContain("duration_s:");
    });

    it("closes the SDK query even when footer emission throws", async () => {
      const mockQuery = createMockQuery([
        {
          type: "system",
          subtype: "init",
          session_id: "s-fin-footer-throw",
          tools: [],
          model: "claude-haiku-4-5",
        },
        {
          type: "result",
          subtype: "success",
          session_id: "s-fin-footer-throw",
          num_turns: 1,
          total_cost_usd: 0,
        },
      ]);
      (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

      // Throw on the first footer line so the entire writeFooter call aborts
      process.stdout.write = ((chunk: string) => {
        stdoutOutput += chunk;
        if (chunk.includes("turns:")) {
          throw new Error("stdout closed during footer");
        }
        return true;
      }) as typeof process.stdout.write;

      await expect(runSession(minConfig())).rejects.toThrow("stdout closed during footer");
      expect(mockQuery.close).toHaveBeenCalledTimes(1);
    });
  });
});
