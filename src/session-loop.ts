import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  SDKStartupFailureReason,
  SDKSystemMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { unresolvedSlashCommandWarning } from './slash-command.js';
import {
  lostThisSessionsTranscript,
  startupFailureHint,
  transcriptLostWarning,
} from './sdk-diagnostics.js';
import type { SessionConfig } from './config.js';
import { type Oracle, AskUserQuestionInputSchema } from './oracle.js';
import { SyntheticUser } from './synthetic-user.js';
import {
  EXIT_SUCCESS,
  EXIT_RUNTIME_ERROR,
  EXIT_BUDGET_EXCEEDED,
  EXIT_MAX_TURNS,
} from './exit-codes.js';
import {
  writeHeader,
  writeUser,
  writeThinking,
  writeAssistant,
  writeTool,
  writeHook,
  type HookResponse,
  writeResult,
  type AskedQuestion,
  recordsResult,
  writeOracleAsk,
  writeOracleTurn,
  writeOracleError,
} from './transcript.js';

type ToolResultBlock = Extract<
  Exclude<SDKUserMessage['message']['content'], string>[number],
  { type: 'tool_result' }
>;

export type SyntheticAction = { type: 'continue'; message: string } | { type: 'end' };

export interface SessionState {
  readonly config: SessionConfig;
  readonly configPaths: string[];
  readonly projectDir: string;
  readonly sandboxHome: string | undefined;
  readonly claudeDir: string | undefined;
  readonly oracle: Oracle;

  sessionId?: string;
  sdkSessionPath?: string;
  // Create a lazy SyntheticUser — initialized once we have a session ID
  syntheticUser?: SyntheticUser;
  resolveNextAction?: (action: SyntheticAction) => void;
  // SessionStart and first-prompt hooks fire before init, so their entries
  // wait for the header and the prompt's own entry.
  hooksBeforeInit: HookResponse[];
  toolCallCount: number;
  toolCalls: Map<string, { name: string; id: number }>;
  filesWritten: Set<string>;
  filesEdited: Set<string>;
  filesRead: Set<string>;
  resultNumTurns: number;
  resultTotalCostUsd: number;
  // Tracks whether the in-flight turn produced an SDK result. Reset when a
  // continuation turn is dispatched, so a crash after an earlier turn's result
  // still marks the agent cost incomplete. The SDK only reports a dollar total
  // on the result message, so without one the turn's spend is unknown.
  resultArrived: boolean;
  transcriptIncomplete: boolean;
  oracleFailed: boolean;
  exitCode: number;
}

export type SessionInputs = Pick<
  SessionState,
  'config' | 'configPaths' | 'projectDir' | 'sandboxHome' | 'claudeDir' | 'oracle'
>;

export function newSessionState(inputs: SessionInputs): SessionState {
  return {
    ...inputs,
    hooksBeforeInit: [],
    toolCallCount: 0,
    toolCalls: new Map(),
    filesWritten: new Set<string>(),
    filesEdited: new Set<string>(),
    filesRead: new Set<string>(),
    resultNumTurns: 0,
    resultTotalCostUsd: 0,
    resultArrived: false,
    transcriptIncomplete: false,
    oracleFailed: false,
    exitCode: EXIT_SUCCESS,
  };
}

// Build the async generator for multi-turn input
export async function* inputMessages(state: SessionState) {
  // Yield initial prompt
  yield {
    type: 'user' as const,
    session_id: '',
    message: {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: state.config.prompt }],
    },
    parent_tool_use_id: null,
  };

  // Multi-turn loop
  while (true) {
    const action = await new Promise<SyntheticAction>((resolve) => {
      state.resolveNextAction = resolve;
    });
    if (action.type === 'end') {
      return;
    }
    yield {
      type: 'user' as const,
      session_id: '',
      message: {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: action.message }],
      },
      parent_tool_use_id: null,
    };
  }
}

// canUseTool callback. The Agent SDK's PermissionResult schema requires
// `updatedInput` on the allow branch and `message` on the deny branch;
// returning a bare `{ behavior }` triggers a ZodError for every tool call.
export function canUseTool(state: SessionState, abortController: AbortController) {
  return async (toolName: string, input: Record<string, unknown>) => {
    if (toolName === 'AskUserQuestion' && state.syntheticUser) {
      const parsed = AskUserQuestionInputSchema.safeParse(input);
      if (!parsed.success) {
        return { behavior: 'deny', message: 'AskUserQuestion input failed schema validation' };
      }
      try {
        const result = await state.syntheticUser.handleAskUserQuestion(parsed.data);
        writeOracleAsk(result.oracleResponse.answers, result.oracleResponse.reasoning);
        return {
          behavior: result.behavior,
          updatedInput: result.updatedInput,
        };
      } catch (err) {
        state.oracleFailed = true;
        writeOracleError(err instanceof Error ? err.message : String(err));
        abortController.abort();
        return { behavior: 'deny', message: 'Synthetic-user oracle aborted with an error' };
      }
    }
    return { behavior: 'allow', updatedInput: input };
  };
}

export async function handleMessage(message: SDKMessage, state: SessionState): Promise<void> {
  switch (message.type) {
    case 'system':
      handleSystem(message, state);
      break;
    case 'assistant':
      handleAssistant(message, state);
      break;
    case 'user':
      handleUser(message, state);
      break;
    case 'result':
      await handleResult(message, state);
      break;
  }
}

function handleSystem(message: Extract<SDKMessage, { type: 'system' }>, state: SessionState): void {
  switch (message.subtype) {
    case 'init':
      if (!state.sessionId) handleInit(message, state);
      break;
    case 'hook_response':
      if (state.sessionId) writeHook(message);
      else state.hooksBeforeInit.push(message);
      break;
    case 'session_writes_lost':
      if (lostThisSessionsTranscript(message, state.sessionId)) {
        state.transcriptIncomplete = true;
        process.stderr.write(transcriptLostWarning(message, state.sdkSessionPath));
      }
      break;
  }
}

function handleInit(message: SDKSystemMessage, state: SessionState): void {
  const { config } = state;
  const sessionId = message.session_id;
  state.sessionId = sessionId;

  const slashWarning = unresolvedSlashCommandWarning(config.prompt, message.slash_commands ?? []);
  if (slashWarning) process.stderr.write(slashWarning);

  const syntheticUser = new SyntheticUser(state.oracle, config.user, config.prompt);
  state.syntheticUser = syntheticUser;

  // Write YAML header and first user message
  state.sdkSessionPath = buildSdkSessionPath(
    state.projectDir,
    sessionId,
    state.sandboxHome,
    state.claudeDir,
  );
  writeHeader({
    session: sessionId,
    configPaths: state.configPaths,
    projectDir: state.projectDir,
    transcriptPath: state.sdkSessionPath,
  });
  writeUser(config.prompt);
  state.hooksBeforeInit.forEach(writeHook);

  // Add initial prompt to conversation buffer
  syntheticUser.addUserMessage(config.prompt);
}

function handleAssistant(message: SDKAssistantMessage, state: SessionState): void {
  const content = message.message?.content;
  if (content && Array.isArray(content)) {
    const textParts: string[] = [];
    for (const block of content) {
      if (block.type === 'thinking' && block.thinking) {
        writeThinking(block.thinking);
      } else if (block.type === 'text' && block.text) {
        writeAssistant(block.text);
        textParts.push(block.text);
      } else if (block.type === 'tool_use' && block.name) {
        const id = ++state.toolCallCount;
        writeTool(block.name, block.input, id);
        state.toolCalls.set(block.id, { name: block.name, id });
        recordToolFile(block.name, block.input, state);
      }
    }
    if (textParts.length > 0 && state.syntheticUser) {
      state.syntheticUser.addAssistantMessage(textParts.join('\n'));
    }
  }
}

function handleUser(message: Extract<SDKMessage, { type: 'user' }>, state: SessionState): void {
  if ('isReplay' in message && message.isReplay) return;
  const content = message.message.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type !== 'tool_result') continue;
    const call = state.toolCalls.get(block.tool_use_id);
    if (!call) continue;
    // Under CLI 2.1.317 most successful results carry no is_error key; Bash sets it false.
    const isError = block.is_error === true;
    if (!recordsResult(call.name, isError)) continue;
    writeResult({
      tool: call.name,
      id: call.id,
      isError,
      questions:
        call.name === 'AskUserQuestion' ? askedQuestions(message.tool_use_result) : undefined,
      text: toolResultText(block.content),
    });
  }
}

function toolResultText(content: ToolResultBlock['content']): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join('\n');
}

// An AskUserQuestion call's structured result holds the questions after any
// PreToolUse hook rewrote them. Under CLI 2.1.317 it is absent on subagent
// results, and failed calls carry an "Error: ..." string instead.
const AnsweredQuestionsSchema = z.object({
  questions: z.array(
    z.object({ question: z.string(), options: z.array(z.object({ label: z.string() })) }),
  ),
});

function askedQuestions(toolUseResult: unknown): AskedQuestion[] | undefined {
  const parsed = AnsweredQuestionsSchema.safeParse(toolUseResult);
  if (!parsed.success) return undefined;
  return parsed.data.questions.map((q) => ({
    question: q.question,
    options: q.options.map((o) => o.label),
  }));
}

async function handleResult(message: SDKResultMessage, state: SessionState): Promise<void> {
  const subtype = message.subtype;
  state.resultArrived = true;

  // Extract stats from result
  state.resultNumTurns = message.num_turns || 0;
  state.resultTotalCostUsd = message.total_cost_usd || 0;

  const { syntheticUser } = state;
  if (subtype === 'success' && syntheticUser) {
    // Consult turn policy
    const decision = await syntheticUser.decideTurn();

    // Write oracle turn policy decision only when the oracle was
    // actually consulted. Cap-driven short-circuits (max_turns=0
    // or userTurnCount>=cap) leave reasoning undefined and emit
    // no transcript entry, per spec rule TurnPolicyEndsByCap.
    if (decision.reasoning !== undefined) {
      writeOracleTurn(decision.decision, decision.message, decision.reasoning);
    }

    if (decision.decision === 'continue' && decision.message) {
      syntheticUser.addUserMessage(decision.message);
      writeUser(decision.message);
      // A new turn is now in flight; its result has not arrived yet.
      state.resultArrived = false;
      state.resolveNextAction?.({ type: 'continue', message: decision.message });
    } else {
      state.resolveNextAction?.({ type: 'end' });
      state.exitCode = EXIT_SUCCESS;
    }
  } else {
    state.resolveNextAction?.({ type: 'end' });
    state.exitCode = exitCodeForUnfinishedResult(message, state.config.sandbox.enabled);
  }
}

// Covers error subtypes, and a success result that arrives before init (no
// synthetic user to consult), which can only end the session as a failure.
function exitCodeForUnfinishedResult(message: SDKResultMessage, sandboxEnabled: boolean): number {
  if (message.subtype === 'error_max_turns') return EXIT_MAX_TURNS;
  if (message.subtype === 'error_max_budget_usd') return EXIT_BUDGET_EXCEEDED;
  if ((message as { terminal_reason?: string }).terminal_reason === 'max_turns') {
    // The turn cap was reached mid-execution: a tool/skill call was accepted
    // as the Nth tool use, then the next model turn could not start. The SDK
    // reports error_during_execution but attributes the cause via
    // terminal_reason = max_turns, so the same logical condition as
    // error_max_turns yields the same exit code regardless of where in the
    // tool-call lifecycle the cap fired (spec rule
    // AgentTurnHitsTurnCapDuringExecution).
    return EXIT_MAX_TURNS;
  }
  // Surface the SDK's error detail as a diagnostic annotation paired with the
  // runtime-error exit code (spec rule AgentTurnFailsAtRuntime). Informational
  // only; downstream tools should not parse it.
  const sdkErrors = (message as { errors?: string[] }).errors;
  if (sdkErrors && sdkErrors.length > 0) {
    process.stderr.write(`[scuttlerun] ${sdkErrors.join('\n')}\n`);
  }
  const hint = startupFailureHint(
    (message as { startup_failure_reason?: SDKStartupFailureReason }).startup_failure_reason,
    sandboxEnabled,
  );
  if (hint) process.stderr.write(hint);
  return EXIT_RUNTIME_ERROR;
}

// BetaToolUseBlock.input is typed `unknown` by the SDK because tool input shapes
// are user-defined. We only read file_path for the built-in Read/Write/Edit tools.
function recordToolFile(name: string, input: unknown, state: SessionState): void {
  const inp = input as Record<string, unknown>;
  if (typeof inp.file_path !== 'string') return;
  if (name === 'Write') state.filesWritten.add(inp.file_path);
  if (name === 'Edit') state.filesEdited.add(inp.file_path);
  if (name === 'Read') state.filesRead.add(inp.file_path);
}

function buildSdkSessionPath(
  cwd: string,
  sessionId: string,
  sandboxHome?: string,
  claudeDir?: string,
): string {
  const home = sandboxHome || process.env.HOME;
  if (!home && !claudeDir) {
    throw new Error(
      'Cannot locate SDK session file: HOME is not set. scuttlerun requires HOME to be set when sandbox is disabled.',
    );
  }
  let resolved: string;
  try {
    resolved = realpathSync(cwd);
  } catch {
    resolved = cwd;
  }
  const encodedCwd = resolved.replace(/[/_]/g, '-');
  return `${claudeDir ?? `${home}/.claude`}/projects/${encodedCwd}/${sessionId}.jsonl`;
}
