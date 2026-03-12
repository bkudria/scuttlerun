import { query } from "@anthropic-ai/claude-agent-sdk";
import { realpathSync } from "node:fs";
import type { SessionConfig } from "./config.js";
import { Oracle } from "./oracle.js";
import { SyntheticUser } from "./synthetic-user.js";
import { scaffoldProject, createProjectDir } from "./project.js";
import {
  writeHeader,
  writeUser,
  writeThinking,
  writeAssistant,
  writeTool,
  writeOracleAsk,
  writeOracleTurn,
  writeFooter,
} from "./transcript.js";

export interface RunResult {
  exitCode: number;
  sessionId?: string;
}

export interface RunOptions {
  timeoutSeconds?: number;
  verbose?: boolean;
  configDir?: string;
  configPaths?: string[];
}

export async function runSession(
  config: SessionConfig,
  options: RunOptions = {},
): Promise<RunResult> {
  const { timeoutSeconds = 300, verbose = false } = options;

  // Prevent nested session errors
  delete process.env.CLAUDECODE;

  let sessionId: string | undefined;
  let queryHandle: ReturnType<typeof query> | undefined;

  // Always create a project directory
  let projectDir: string;
  if (config.project) {
    const configDir = options.configDir || process.cwd();
    const result = await scaffoldProject(config.project, configDir);
    projectDir = result.projectPath;
    if (verbose) {
      process.stderr.write(`[warren] Scaffolded project at ${projectDir}\n`);
    }
  } else {
    projectDir = await createProjectDir();
  }

  const cwd = projectDir;

  // Create oracle
  const oracle = new Oracle(config.user.oracle_model);

  // Set up timeout
  const abortController = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  // Track stats
  let toolCallCount = 0;

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
    if (verbose) {
      sdkOptions.stderr = (data: string) => {
        process.stderr.write(data);
      };
    }

    // Create a lazy SyntheticUser — initialized once we have a session ID
    let syntheticUser: SyntheticUser | undefined;

    // canUseTool callback
    sdkOptions.canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
    ) => {
      if (toolName === "AskUserQuestion" && syntheticUser) {
        const result = await syntheticUser.handleAskUserQuestion(
          input as { questions: any[] },
        );
        writeOracleAsk(
          result.oracleResponse.answers,
          result.oracleResponse.reasoning,
        );
        return {
          behavior: result.behavior,
          updatedInput: result.updatedInput,
        };
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
    let resultNumTurns = 0;
    let resultTotalCostUsd = 0;

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

      if (message.type === "system" && message.subtype === "init" && !sessionId) {
        sessionId = message.session_id as string;
        syntheticUser = new SyntheticUser(oracle, config.user, config.prompt);

        // Write YAML header and first user message
        const sdkSessionPath = buildSdkSessionPath(cwd, sessionId);
        writeHeader({
          session: sessionId,
          configPaths: options.configPaths || [],
          projectDir,
          transcriptPath: sdkSessionPath,
        });
        writeUser(config.prompt);

        // Add initial prompt to conversation buffer
        syntheticUser.addUserMessage(config.prompt);
      } else if (message.type === "assistant") {
        const content = (message as any).message?.content;
        if (content && Array.isArray(content)) {
          const textParts: string[] = [];
          for (const block of content) {
            if (block.type === "thinking" && block.thinking) {
              writeThinking(block.thinking);
            } else if (block.type === "text" && block.text) {
              writeAssistant(block.text);
              textParts.push(block.text);
            } else if (block.type === "tool_use" && block.name) {
              writeTool(block.name, block.input);
              toolCallCount++;
            }
          }
          if (textParts.length > 0 && syntheticUser) {
            syntheticUser.addAssistantMessage(textParts.join("\n"));
          }
        }
      } else if (message.type === "result") {
        const subtype = message.subtype as string;

        // Extract stats from result
        resultNumTurns = (message.num_turns as number) || 0;
        resultTotalCostUsd = (message.total_cost_usd as number) || 0;

        if (subtype === "success" && syntheticUser) {
          // Consult turn policy
          const decision = await syntheticUser.decideTurn();

          // Write oracle turn policy decision
          if (config.user.turn_policy === "reactive") {
            writeOracleTurn(decision.decision, decision.message, decision.reasoning);
          }

          if (decision.decision === "continue" && decision.message) {
            syntheticUser.addUserMessage(decision.message);
            writeUser(decision.message);
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

    // Write footer
    writeFooter({
      turns: resultNumTurns,
      toolCalls: toolCallCount,
      durationMs: duration,
      totalCostUsd: resultTotalCostUsd,
    });

    return { exitCode, sessionId };
  } catch (err: unknown) {
    if (timedOut) {
      return { exitCode: 5, sessionId };
    }

    return { exitCode: 2, sessionId };
  } finally {
    // Clear timeout
    if (timeoutHandle) clearTimeout(timeoutHandle);

    // Close query handle
    if (queryHandle && typeof (queryHandle as any).close === "function") {
      (queryHandle as any).close();
    }

    // No cleanup — project dir is preserved
  }
}

function buildSdkSessionPath(cwd: string, sessionId: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  let resolved: string;
  try {
    resolved = realpathSync(cwd);
  } catch {
    resolved = cwd;
  }
  const encodedCwd = resolved.replace(/[/_]/g, "-");
  return `${home}/.claude/projects/${encodedCwd}/${sessionId}.jsonl`;
}
