import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SessionConfig } from "./config.js";
import { EventRecorder } from "./events.js";
import { Oracle } from "./oracle.js";
import { SyntheticUser } from "./synthetic-user.js";
import { scaffoldProject, cleanupProject } from "./project.js";
import { dirname } from "node:path";

export interface RunResult {
  exitCode: number;
  sessionId?: string;
}

export interface RunOptions {
  timeoutSeconds?: number;
  verbose?: boolean;
  quiet?: boolean;
  keepProject?: boolean;
  configDir?: string;
}

export async function runSession(
  config: SessionConfig,
  options: RunOptions = {},
): Promise<RunResult> {
  const { timeoutSeconds = 300, verbose = false, keepProject = false } = options;

  // Prevent nested session errors
  delete process.env.CLAUDECODE;

  let sessionId: string | undefined;
  let scaffoldedPath: string | undefined;
  let queryHandle: ReturnType<typeof query> | undefined;
  const stderrBuffer: string[] = [];

  // Determine working directory
  let cwd = config.cwd || process.cwd();

  // Scaffold project if configured
  if (config.project) {
    const configDir = options.configDir || process.cwd();
    const result = await scaffoldProject(config.project, configDir);
    scaffoldedPath = result.projectPath;
    cwd = scaffoldedPath;
    if (verbose) {
      process.stderr.write(`[warren] Scaffolded project at ${scaffoldedPath}\n`);
    }
  }

  // Create event recorder with a temp path until we know the session ID
  const eventsPath = config.output.events;
  // We'll create the recorder once we have the session ID, but need a temp one first
  let recorder: EventRecorder | undefined;

  // Create oracle
  const oracle = new Oracle(config.user.oracle_model);

  // Set up timeout
  const abortController = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    // Build the async generator for multi-turn input
    let resolveNextAction: ((action: { type: string; message?: string }) => void) | undefined;

    async function* inputGenerator() {
      // Yield initial prompt
      yield {
        type: "user" as const,
        session_id: "",
        message: {
          role: "user" as const,
          content: [{ type: "text" as const, text: config.prompt }],
        },
        parent_tool_use_id: null,
      };

      // Multi-turn loop
      while (true) {
        const action = await new Promise<{ type: string; message?: string }>((resolve) => {
          resolveNextAction = resolve;
        });
        if (action.type === "end") {
          return;
        }
        yield {
          type: "user" as const,
          session_id: "",
          message: {
            role: "user" as const,
            content: [{ type: "text" as const, text: action.message! }],
          },
          parent_tool_use_id: null,
        };
      }
    }

    // Build SDK options
    const sdkOptions: Record<string, unknown> = {
      cwd,
      permissionMode: config.permission_mode,
      allowDangerouslySkipPermissions: config.permission_mode === "bypassPermissions",
      tools: config.tools,
      maxTurns: config.max_turns,
      abortController,
      effort: config.effort,
      settingSources: config.sdk.setting_sources,
    };

    if (config.model) sdkOptions.model = config.model;
    if (config.max_budget_usd) sdkOptions.maxBudgetUsd = config.max_budget_usd;
    if (config.system_prompt) sdkOptions.systemPrompt = config.system_prompt;
    if (config.disallowed_tools) sdkOptions.disallowedTools = config.disallowed_tools;
    if (config.sdk.thinking) sdkOptions.thinking = config.sdk.thinking;
    if (config.sdk.mcp_servers) sdkOptions.mcpServers = config.sdk.mcp_servers;
    if (config.sdk.agents) sdkOptions.agents = config.sdk.agents;
    if (config.sdk.env) sdkOptions.env = config.sdk.env;

    // Stderr capture
    sdkOptions.stderr = (data: string) => {
      stderrBuffer.push(data);
      if (verbose) {
        process.stderr.write(data);
      }
    };

    // Create a lazy SyntheticUser — initialized once we have a recorder
    let syntheticUser: SyntheticUser | undefined;

    // canUseTool callback
    sdkOptions.canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      opts: { toolUseID: string; agentID?: string },
    ) => {
      if (toolName === "AskUserQuestion" && syntheticUser) {
        return syntheticUser.handleAskUserQuestion(
          input as { questions: any[] },
          opts.toolUseID,
        );
      }
      return { behavior: "allow" };
    };

    // Start timeout
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, timeoutSeconds * 1000);

    // Launch the query
    queryHandle = query({
      prompt: inputGenerator(),
      options: sdkOptions,
    }) as any;

    let exitCode = 0;
    const startTime = Date.now();

    // Process messages — race each iteration against the abort signal
    const iterator = (queryHandle as AsyncIterable<Record<string, unknown>>)[Symbol.asyncIterator]();
    while (true) {
      const abortPromise = new Promise<{ done: true; value: undefined }>((resolve) => {
        abortController.signal.addEventListener("abort", () => {
          resolve({ done: true, value: undefined });
        }, { once: true });
        // If already aborted, resolve immediately
        if (abortController.signal.aborted) {
          resolve({ done: true, value: undefined });
        }
      });

      const result = await Promise.race([iterator.next(), abortPromise]);
      if (result.done || timedOut) break;
      const message = result.value as Record<string, unknown>;

      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id as string;
        recorder = new EventRecorder(eventsPath, sessionId);
        syntheticUser = new SyntheticUser(oracle, recorder, config.user, config.prompt);

        // Record session start
        await recorder.writeEvent("session_start", {
          config: sanitizeConfig(config),
          warren_version: "0.1.0",
          sdk_session_path: buildSdkSessionPath(cwd, sessionId),
          ...(scaffoldedPath ? { scaffolded_project_path: scaffoldedPath } : {}),
        });

        // Add initial prompt to conversation buffer
        syntheticUser.addUserMessage(config.prompt);

        if (!options.quiet) {
          process.stderr.write(`[warren] Session started: ${sessionId}\n`);
        }
      } else if (message.type === "assistant") {
        // Extract text blocks from assistant messages for conversation buffer
        const content = (message as any).message?.content;
        if (content && syntheticUser) {
          const textParts: string[] = [];
          for (const block of content) {
            if (block.type === "text") {
              textParts.push(block.text);
            }
          }
          if (textParts.length > 0) {
            syntheticUser.addAssistantMessage(textParts.join("\n"));
          }
        }
      } else if (message.type === "result") {
        const subtype = message.subtype as string;

        if (subtype === "success" && syntheticUser) {
          // Consult turn policy
          const decision = await syntheticUser.decideTurn();

          if (decision.decision === "continue" && decision.message) {
            syntheticUser.addUserMessage(decision.message);
            resolveNextAction?.({ type: "continue", message: decision.message });
          } else {
            resolveNextAction?.({ type: "end" });
            exitCode = 0;
          }
        } else {
          // Error subtypes
          resolveNextAction?.({ type: "end" });
          if (subtype === "error_max_turns") exitCode = 3;
          else if (subtype === "error_max_budget_usd") exitCode = 4;
          else exitCode = 2;
        }
      }
    }

    const duration = Date.now() - startTime;

    // Check for timeout
    if (timedOut) {
      exitCode = 5;
    }

    // Write stderr event if there's buffered output
    if (stderrBuffer.length > 0 && recorder) {
      await recorder.writeEvent("agent_stderr", {
        text: stderrBuffer.join(""),
      });
    }

    // Write session end
    if (recorder) {
      await recorder.writeEvent("session_end", {
        stop_reason: timedOut ? "timeout" : "end_turn",
        subtype: exitCode === 0 ? "success" : "error",
        is_error: exitCode !== 0,
        total_turns: 0, // TODO: track from ResultMessages
        total_cost_usd: 0,
        duration_ms: duration,
        oracle_usage_total: oracle.getTotalUsage(),
      });
    }

    return { exitCode, sessionId };
  } catch (err: unknown) {
    if (timedOut) {
      // Timeout case
      if (recorder) {
        await recorder.writeEvent("session_end", {
          stop_reason: "timeout",
          subtype: "timeout",
          is_error: true,
          total_turns: 0,
          total_cost_usd: 0,
          duration_ms: 0,
          oracle_usage_total: oracle.getTotalUsage(),
        });
      }
      return { exitCode: 5, sessionId };
    }

    // Write error event
    if (recorder) {
      await recorder.writeEvent("error", {
        error_type: "session_error",
        message: err instanceof Error ? err.message : String(err),
        recoverable: false,
      });
    }

    return { exitCode: 2, sessionId };
  } finally {
    // Clear timeout
    if (timeoutHandle) clearTimeout(timeoutHandle);

    // Close query handle
    if (queryHandle && typeof (queryHandle as any).close === "function") {
      (queryHandle as any).close();
    }

    // Clean up scaffolded project
    if (scaffoldedPath && !keepProject) {
      await cleanupProject(scaffoldedPath);
    } else if (scaffoldedPath && keepProject) {
      process.stderr.write(`[warren] Keeping scaffolded project at ${scaffoldedPath}\n`);
    }
  }
}

function sanitizeConfig(config: SessionConfig): Record<string, unknown> {
  // Remove potentially sensitive data from config for logging
  const sanitized = { ...config };
  // Remove SDK env vars (may contain secrets)
  if (sanitized.sdk?.env) {
    const sdk = { ...sanitized.sdk };
    sdk.env = Object.fromEntries(
      Object.keys(sdk.env!).map((k) => [k, "***"]),
    );
    (sanitized as any).sdk = sdk;
  }
  return sanitized as unknown as Record<string, unknown>;
}

function buildSdkSessionPath(cwd: string, sessionId: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const encodedCwd = cwd.replace(/\//g, "-");
  return `${home}/.claude/projects/${encodedCwd}/${sessionId}.jsonl`;
}
