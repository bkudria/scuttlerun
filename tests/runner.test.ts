import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runSession, type RunResult } from "../src/runner.js";
import type { SessionConfig } from "../src/config.js";

// Mock all dependencies
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: vi.fn(),
  };
});
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = {
        parse: vi.fn(),
      };
    },
  };
});
vi.mock("../src/project.js", () => {
  return {
    createProjectDir: vi.fn().mockResolvedValue("/tmp/warren-project-test123"),
    scaffoldProject: vi.fn().mockResolvedValue({ projectPath: "/tmp/warren-project-scaffold123" }),
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
import { createProjectDir as mockCreateProjectDir, scaffoldProject as mockScaffoldProject } from "../src/project.js";

function minConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    prompt: "Write a haiku",
    max_turns: 50,
    effort: "high",
    tools: ["Read", "Write", "AskUserQuestion"],
    permission_mode: "bypassPermissions",
    user: {
      oracle_model: "claude-haiku-4-5",
      turn_policy: "single",
      max_user_turns: 5,
    },
    sdk: { setting_sources: [] },
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
    (mockCreateProjectDir as ReturnType<typeof vi.fn>).mockResolvedValue("/tmp/warren-project-test123");
    (mockScaffoldProject as ReturnType<typeof vi.fn>).mockResolvedValue({ projectPath: "/tmp/warren-project-scaffold123" });
    delete process.env.CLAUDECODE;
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

    await runSession(minConfig({
      project: { claude_md: "Test", git_init: false },
    }));

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
    expect(stdoutOutput).toContain("- user: |");
    expect(stdoutOutput).toContain("Write a haiku");
    expect(stdoutOutput).toContain("- assistant: |");
    expect(stdoutOutput).toContain("Here is your haiku.");
    expect(stdoutOutput).toContain("turns:");
  });

  it("handles error_max_turns with exit code 3", async () => {
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

    expect(result.exitCode).toBe(3);
  });

  it("handles error_max_budget_usd with exit code 4", async () => {
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

    expect(result.exitCode).toBe(4);
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
        num_turns: 1,
        total_cost_usd: 0.01,
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
    let capturedCanUseTool: Function | undefined;

    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation((opts: any) => {
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
    });

    await runSession(minConfig());

    // Verify canUseTool was passed to query
    expect(capturedCanUseTool).toBeDefined();

    // Non-AskUserQuestion tools should be allowed
    const allowResult = await capturedCanUseTool!("Read", {});
    expect(allowResult.behavior).toBe("allow");
  });

  it("handles timeout with exit code 5", async () => {
    // Create a query that never finishes
    const neverEndingQuery = {
      close: vi.fn(),
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: "system",
          subtype: "init",
          session_id: "s-timeout",
          tools: [],
          model: "claude-haiku-4-5",
        };
        // Simulate hanging
        await new Promise(() => {}); // never resolves
      },
    };

    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(neverEndingQuery);

    const config = minConfig();
    // Use a very short timeout for testing
    const result = await runSession(config, { timeoutSeconds: 0.1 });

    expect(result.exitCode).toBe(5);
    expect(neverEndingQuery.close).toHaveBeenCalled();
  });

  it("deletes process.env.CLAUDECODE before calling query", async () => {
    process.env.CLAUDECODE = "1";

    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(() => {
      // At this point, CLAUDECODE should be deleted
      expect(process.env.CLAUDECODE).toBeUndefined();
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
    });

    await runSession(minConfig());
  });

  it("sets HOME to sandbox home dir when sandbox is enabled", async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation((opts: any) => {
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
    });

    await runSession(minConfig());

    const env = capturedOptions?.env as Record<string, string>;
    expect(env).toBeDefined();
    expect(env.HOME).toBe("/tmp/warren-project-test123/.home");
  });

  it("does not set env when sandbox is disabled and no sdk.env", async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation((opts: any) => {
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
    });

    await runSession(minConfig({
      sandbox: {
        enabled: false,
        network: { allowed_domains: [], allow_local_binding: false },
        filesystem: {
          deny_read: [],
          allow_write: [],
          deny_write: [],
        },
      },
    }));

    expect(capturedOptions?.env).toBeUndefined();
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
            { type: "tool_use", id: "tu-1", name: "Write", input: { file_path: "/tmp/ocean.txt", content: "waves" } },
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
    // Footer should count the tool call
    expect(stdoutOutput).toContain("tool_calls: 1");
  });
});
