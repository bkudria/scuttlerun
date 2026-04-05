import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runSession } from "../src/runner.js";
import type { SessionConfig } from "../src/config.js";

// Mock all dependencies
vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: vi.fn(),
  };
});
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
    scaffoldProject: vi.fn().mockResolvedValue({ projectPath: "/tmp/scuttlerun-project-scaffold123" }),
  };
});
vi.mock("../src/cleanup.js", () => {
  return {
    cleanOldProjects: vi.fn().mockResolvedValue(0),
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
    (mockCreateProjectDir as ReturnType<typeof vi.fn>).mockResolvedValue("/tmp/scuttlerun-project-test123");
    (mockScaffoldProject as ReturnType<typeof vi.fn>).mockResolvedValue({ projectPath: "/tmp/scuttlerun-project-scaffold123" });
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
    expect(stdoutOutput).toContain("- user:");
    expect(stdoutOutput).toContain("Write a haiku");
    expect(stdoutOutput).toContain("- assistant:");
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

    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation((opts: { options: { canUseTool?: CanUseToolFn } }) => {
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
    const allowResult = await capturedCanUseTool!("Read", {}) as { behavior: string };
    expect(allowResult.behavior).toBe("allow");
  });

  it("denies AskUserQuestion with malformed input", async () => {
    type CanUseToolFn = (toolName: string, input: Record<string, unknown>) => Promise<unknown>;
    let capturedCanUseTool: CanUseToolFn | undefined;

    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation((opts: { options: { canUseTool?: CanUseToolFn } }) => {
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
    });

    await runSession(minConfig());
    expect(capturedCanUseTool).toBeDefined();

    // Malformed AskUserQuestion input should be denied
    const denyResult = await capturedCanUseTool!("AskUserQuestion", { garbage: true }) as { behavior: string };
    expect(denyResult.behavior).toBe("deny");
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

    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation((opts: Record<string, Record<string, unknown>>) => {
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
    expect(env.HOME).toBe("/tmp/scuttlerun-project-test123/.home");
  });

  it("does not set env when sandbox is disabled and no sdk.env", async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation((opts: Record<string, Record<string, unknown>>) => {
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
            { type: "tool_use", id: "tu-2", name: "Edit", input: { file_path: "/tmp/shore.txt", old_string: "a", new_string: "b" } },
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

  it("logs verbose output when scaffolding a project", async () => {
    const mockQuery = createMockQuery([
      { type: "system", subtype: "init", session_id: "s-verbose-project", tools: [], model: "claude-haiku-4-5" },
      { type: "result", subtype: "success", session_id: "s-verbose-project", num_turns: 1, total_cost_usd: 0 },
    ]);
    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

    let stderrOutput = "";
    const origStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => { stderrOutput += chunk; return true; }) as typeof process.stderr.write;

    try {
      await runSession(
        minConfig({ project: { claude_md: "test", git_init: false } }),
        { verbose: true },
      );
      expect(stderrOutput).toContain("[scuttlerun] Scaffolded project at");
    } finally {
      process.stderr.write = origStderrWrite;
    }
  });

  it("passes verbose stderr callback that writes to stderr", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation((opts: Record<string, Record<string, unknown>>) => {
      capturedOptions = opts.options;
      return createMockQuery([
        { type: "system", subtype: "init", session_id: "s-stderr", tools: [], model: "claude-haiku-4-5" },
        { type: "result", subtype: "success", session_id: "s-stderr", num_turns: 1, total_cost_usd: 0 },
      ]);
    });

    let stderrOutput = "";
    const origStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => { stderrOutput += chunk; return true; }) as typeof process.stderr.write;

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
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation((opts: Record<string, Record<string, unknown>>) => {
      capturedOptions = opts.options;
      return createMockQuery([
        { type: "system", subtype: "init", session_id: "s-env", tools: [], model: "claude-haiku-4-5" },
        { type: "result", subtype: "success", session_id: "s-env", num_turns: 1, total_cost_usd: 0 },
      ]);
    });

    await runSession(minConfig({
      sandbox: {
        enabled: false,
        network: { allowed_domains: [], allow_local_binding: false },
        filesystem: { deny_read: [], allow_write: [], deny_write: [] },
      },
      sdk: { system_prompt: { preset: "claude_code" as const }, env: { FOO: "bar" }, setting_sources: [] },
    }));

    expect(capturedOptions?.env).toEqual({ FOO: "bar" });
  });

  it("writes thinking blocks from assistant messages", async () => {
    const mockQuery = createMockQuery([
      { type: "system", subtype: "init", session_id: "s-thinking", tools: [], model: "claude-haiku-4-5" },
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
      { type: "result", subtype: "success", session_id: "s-thinking", num_turns: 1, total_cost_usd: 0 },
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
        parsed_output: { decision: "continue", message: "Please add tests", reasoning: "Task incomplete" },
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
          [Symbol.asyncIterator]: async function* () {
            // Consume initial prompt from generator
            await inputGen.next();

            // Kick off the generator's while loop (waits for resolveNextAction)
            const pendingContinue = inputGen.next();

            yield { type: "system", subtype: "init", session_id: "s-multi", tools: [], model: "claude-haiku-4-5" };
            yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Here is the code." }] } };
            yield { type: "result", subtype: "success", session_id: "s-multi", num_turns: 1, total_cost_usd: 0.01 };
            // Runner processes result → decideTurn → "continue" → resolveNextAction

            // Generator yields follow-up message
            const continueResult = await pendingContinue;
            expect(continueResult.done).toBe(false);

            // Kick off next iteration of generator (waits for resolveNextAction)
            const pendingEnd = inputGen.next();

            yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Tests added." }] } };
            yield { type: "result", subtype: "success", session_id: "s-multi", num_turns: 2, total_cost_usd: 0.02 };
            // Runner processes result → decideTurn → "end" → resolveNextAction({ type: "end" })

            // Generator returns (done: true)
            const endResult = await pendingEnd;
            expect(endResult.done).toBe(true);
          },
        };
      },
    );

    const result = await runSession(minConfig({
      user: { oracle_model: "claude-haiku-4-5", max_turns: 5 },
    }));

    expect(result.exitCode).toBe(0);
    expect(stdoutOutput).toContain("oracle: turn");
    expect(stdoutOutput).toContain("Please add tests");
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
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation((opts: { options: { canUseTool?: CanUseToolFn } }) => {
      capturedCanUseTool = opts.options.canUseTool;
      return {
        close: vi.fn(),
        [Symbol.asyncIterator]: async function* () {
          yield { type: "system", subtype: "init", session_id: "s-ask", tools: ["AskUserQuestion"], model: "claude-haiku-4-5" };
          // After init, syntheticUser is created — call canUseTool
          const askResult = await capturedCanUseTool!("AskUserQuestion", {
            questions: [{
              question: "What language?",
              header: "Language",
              options: [{ label: "TypeScript", description: "TS" }, { label: "Python", description: "Py" }],
              multiSelect: false,
            }],
          }) as { behavior: string; updatedInput: { answers: Record<string, string> } };
          expect(askResult.behavior).toBe("allow");
          expect(askResult.updatedInput.answers["What language?"]).toBe("TypeScript");
          yield { type: "result", subtype: "success", session_id: "s-ask", num_turns: 1, total_cost_usd: 0 };
        },
      };
    });

    await runSession(minConfig());

    expect(stdoutOutput).toContain("oracle: ask_user");
    expect(stdoutOutput).toContain("TypeScript");
  });

  it("returns exit code 2 when query throws a non-timeout error", async () => {
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("SDK crash");
    });

    const result = await runSession(minConfig());
    expect(result.exitCode).toBe(2);
  });

  it("returns exit code 5 when query throws after timeout", async () => {
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(() => {
      // Simulate: timeout fires, then error is thrown
      return {
        close: vi.fn(),
        [Symbol.asyncIterator]: async function* () {
          yield { type: "system", subtype: "init", session_id: "s-throw-timeout", tools: [], model: "claude-haiku-4-5" };
          // Wait for timeout to fire, then throw
          await new Promise<void>((resolve) => setTimeout(resolve, 150));
          throw new Error("aborted");
        },
      };
    });

    const result = await runSession(minConfig(), { timeoutSeconds: 0.1 });
    expect(result.exitCode).toBe(5);
  });

  it("handles timeout during oracle decideTurn (catch with timedOut)", async () => {
    // Oracle call takes longer than timeout, then throws
    mockParse.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 200));
      throw new Error("oracle timed out");
    });

    const mockQuery = createMockQuery([
      { type: "system", subtype: "init", session_id: "s-catch-timeout", tools: [], model: "claude-haiku-4-5" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Code." }] } },
      { type: "result", subtype: "success", session_id: "s-catch-timeout", num_turns: 1, total_cost_usd: 0 },
    ]);
    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

    const result = await runSession(
      minConfig({ user: { oracle_model: "claude-haiku-4-5", max_turns: 5 } }),
      { timeoutSeconds: 0.05 },
    );
    // Timeout fires during oracle call, oracle then throws → catch with timedOut=true
    expect(result.exitCode).toBe(5);
  });

  it("handles already-aborted signal on next loop iteration", async () => {
    // Oracle call takes longer than timeout but succeeds (doesn't throw)
    mockParse
      .mockImplementationOnce(async () => {
        await new Promise(resolve => setTimeout(resolve, 150));
        return {
          parsed_output: { decision: "continue", message: "more", reasoning: "not done" },
          usage: { input_tokens: 50, output_tokens: 20 },
        };
      });

    const mockQuery = createMockQuery([
      { type: "system", subtype: "init", session_id: "s-already-aborted", tools: [], model: "claude-haiku-4-5" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } },
      { type: "result", subtype: "success", session_id: "s-already-aborted", num_turns: 1, total_cost_usd: 0 },
      // More messages that won't be consumed due to timeout
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "More." }] } },
      { type: "result", subtype: "success", session_id: "s-already-aborted", num_turns: 2, total_cost_usd: 0 },
    ]);
    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

    const result = await runSession(
      minConfig({ user: { oracle_model: "claude-haiku-4-5", max_turns: 5 } }),
      { timeoutSeconds: 0.05 },
    );
    // Timeout fires during oracle call. Oracle completes with "continue".
    // Loop re-enters → abortPromise sees already-aborted signal → breaks.
    expect(result.exitCode).toBe(5);
  });

  it("handles error result after generator is consumed (resolveNextAction defined)", async () => {
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation(
      (opts: { prompt: AsyncGenerator; options: Record<string, unknown> }) => {
        const inputGen = opts.prompt;
        return {
          close: vi.fn(),
          [Symbol.asyncIterator]: async function* () {
            // Consume initial prompt
            await inputGen.next();
            // Start generator's while loop (sets resolveNextAction)
            const pending = inputGen.next();

            yield { type: "system", subtype: "init", session_id: "s-err-gen", tools: [], model: "claude-haiku-4-5" };
            yield { type: "result", subtype: "error_during_execution", session_id: "s-err-gen", is_error: true, errors: ["boom"] };
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

  it("uses USERPROFILE fallback in session path when HOME is unset", async () => {
    const origHome = process.env.HOME;
    const origProfile = process.env.USERPROFILE;
    delete process.env.HOME;
    process.env.USERPROFILE = "/Users/fallback";

    try {
      const mockQuery = createMockQuery([
        { type: "system", subtype: "init", session_id: "s-profile", tools: [], model: "claude-haiku-4-5" },
        { type: "result", subtype: "success", session_id: "s-profile", num_turns: 1, total_cost_usd: 0 },
      ]);
      (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

      await runSession(minConfig({
        sandbox: {
          enabled: false,
          network: { allowed_domains: [], allow_local_binding: false },
          filesystem: { deny_read: [], allow_write: [], deny_write: [] },
        },
      }));

      // Transcript path should use USERPROFILE
      expect(stdoutOutput).toContain("/Users/fallback/.claude/projects/");
    } finally {
      process.env.HOME = origHome;
      if (origProfile !== undefined) process.env.USERPROFILE = origProfile;
      else delete process.env.USERPROFILE;
    }
  });

  it("uses empty home in session path when neither HOME nor USERPROFILE is set", async () => {
    const origHome = process.env.HOME;
    const origProfile = process.env.USERPROFILE;
    delete process.env.HOME;
    delete process.env.USERPROFILE;

    try {
      const mockQuery = createMockQuery([
        { type: "system", subtype: "init", session_id: "s-nohome", tools: [], model: "claude-haiku-4-5" },
        { type: "result", subtype: "success", session_id: "s-nohome", num_turns: 1, total_cost_usd: 0 },
      ]);
      (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(mockQuery);

      await runSession(minConfig({
        sandbox: {
          enabled: false,
          network: { allowed_domains: [], allow_local_binding: false },
          filesystem: { deny_read: [], allow_write: [], deny_write: [] },
        },
      }));

      // Transcript path should use empty home: "/.claude/projects/..."
      expect(stdoutOutput).toContain("/.claude/projects/");
    } finally {
      process.env.HOME = origHome;
      if (origProfile !== undefined) process.env.USERPROFILE = origProfile;
      else delete process.env.USERPROFILE;
    }
  });

  it("passes optional SDK config fields when set", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation((opts: Record<string, Record<string, unknown>>) => {
      capturedOptions = opts.options;
      return createMockQuery([
        { type: "system", subtype: "init", session_id: "s-opts", tools: [], model: "claude-haiku-4-5" },
        { type: "result", subtype: "success", session_id: "s-opts", num_turns: 1, total_cost_usd: 0 },
      ]);
    });

    await runSession(minConfig({
      max_budget_usd: 5.0,
      disallowed_tools: ["Agent"],
      sdk: {
        system_prompt: "Be concise",
        thinking: { type: "adaptive" },
        mcp_servers: { test: {} },
        agents: { helper: {} },
        setting_sources: ["project"],
      },
    }));

    expect(capturedOptions?.maxBudgetUsd).toBe(5.0);
    expect(capturedOptions?.systemPrompt).toBe("Be concise");
    expect(capturedOptions?.disallowedTools).toEqual(["Agent"]);
    expect(capturedOptions?.thinking).toEqual({ type: "adaptive" });
    expect(capturedOptions?.mcpServers).toEqual({ test: {} });
    expect(capturedOptions?.agents).toEqual({ helper: {} });
  });

  it("passes claude_code preset as default systemPrompt", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation((opts: Record<string, Record<string, unknown>>) => {
      capturedOptions = opts.options;
      return createMockQuery([
        { type: "system", subtype: "init", session_id: "s-preset", tools: [], model: "claude-haiku-4-5" },
        { type: "result", subtype: "success", session_id: "s-preset", num_turns: 1, total_cost_usd: 0 },
      ]);
    });

    await runSession(minConfig());

    expect(capturedOptions?.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
    });
  });

  it("passes preset with append when configured", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    (mockQueryFn as ReturnType<typeof vi.fn>).mockImplementation((opts: Record<string, Record<string, unknown>>) => {
      capturedOptions = opts.options;
      return createMockQuery([
        { type: "system", subtype: "init", session_id: "s-append", tools: [], model: "claude-haiku-4-5" },
        { type: "result", subtype: "success", session_id: "s-append", num_turns: 1, total_cost_usd: 0 },
      ]);
    });

    await runSession(minConfig({
      sdk: {
        system_prompt: { preset: "claude_code" as const, append: "Be brief." },
        setting_sources: [],
      },
    }));

    expect(capturedOptions?.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "Be brief.",
    });
  });
});
