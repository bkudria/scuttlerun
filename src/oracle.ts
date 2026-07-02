import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { computeCostUsd } from './pricing.js';

// Schema for AskUserQuestion oracle response
const AskUserQuestionResponseSchema = z.object({
  answers: z.array(
    z.object({
      question: z.string(),
      answer: z.string(),
    }),
  ),
  reasoning: z.string(),
});

// Schema for turn policy oracle response
const TurnPolicyResponseSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('continue'),
    message: z.string(),
    reasoning: z.string(),
  }),
  z.object({
    decision: z.literal('end'),
    reasoning: z.string(),
  }),
]);

// JSON Schemas handed to the Agent SDK's structured-output format. Hand-written
// rather than derived via z.toJSONSchema: the SDK's structured-output path
// requires a single top-level object schema — both the oneOf Zod emits for
// discriminated unions and a hand-rolled top-level anyOf make the Claude Code
// subprocess return no structured output and exit 1. The turn-policy union is
// therefore flattened to one object with an optional message; the Zod schemas
// above remain the source of truth for validating the parsed output.
const ASK_USER_QUESTION_OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    answers: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          question: { type: 'string' as const },
          answer: { type: 'string' as const },
        },
        required: ['question', 'answer'],
        additionalProperties: false,
      },
    },
    reasoning: { type: 'string' as const },
  },
  required: ['answers', 'reasoning'],
  additionalProperties: false,
};

const TURN_POLICY_OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    decision: { type: 'string' as const, enum: ['continue', 'end'] },
    message: { type: 'string' as const },
    reasoning: { type: 'string' as const },
  },
  required: ['decision', 'reasoning'],
  additionalProperties: false,
};

export interface ConversationEntry {
  role: 'user' | 'assistant';
  text: string;
}

export interface QuestionInput {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export const QuestionInputSchema = z.object({
  question: z.string(),
  header: z.string(),
  options: z
    .array(z.object({ label: z.string(), description: z.string() }))
    .min(2)
    .max(4),
  multiSelect: z.boolean(),
});

export const AskUserQuestionInputSchema = z.object({
  questions: z.array(QuestionInputSchema).min(1).max(4),
});

export interface AskUserQuestionParams {
  persona: string | undefined;
  conversationContext: ConversationEntry[];
  questions: QuestionInput[];
}

export interface AskUserQuestionResult {
  answers: Record<string, string>;
  reasoning: string;
  usage: { input_tokens: number; output_tokens: number };
}

export interface TurnPolicyParams {
  persona: string | undefined;
  originalPrompt: string;
  conversationContext: ConversationEntry[];
}

export interface TurnPolicyResult {
  decision: 'continue' | 'end';
  message?: string;
  reasoning: string;
  usage: { input_tokens: number; output_tokens: number };
}

export interface OracleUsageTotal {
  input_tokens: number;
  output_tokens: number;
  calls: number;
  cost_usd: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface OracleOptions {
  verbose?: boolean;
  sleep?: (ms: number) => Promise<void>;
  baseDelayMs?: number;
  /**
   * Environment for the oracle's SDK subprocess. Supplied by the runner with
   * the session's auth mode applied; defaults to the parent env with
   * CLAUDECODE unset.
   */
  sdkEnv?: Record<string, string | undefined>;
}

interface OracleUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

const ORACLE_MAX_ATTEMPTS = 4;
const ORACLE_DEFAULT_BASE_DELAY_MS = 250;
// Headroom for the SDK's internal structured-output round trips; the oracle
// runs with no tools, so real sessions complete in a single turn.
const ORACLE_MAX_TURNS = 10;

export class Oracle {
  private model: string;
  private verbose: boolean;
  private sleep: (ms: number) => Promise<void>;
  private baseDelayMs: number;
  private sdkEnv: Record<string, string | undefined> | undefined;
  private totalUsage: {
    input_tokens: number;
    output_tokens: number;
    calls: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } = {
    input_tokens: 0,
    output_tokens: 0,
    calls: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  constructor(model: string, options: OracleOptions = {}) {
    this.model = model;
    this.verbose = options.verbose ?? false;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.baseDelayMs = options.baseDelayMs ?? ORACLE_DEFAULT_BASE_DELAY_MS;
    this.sdkEnv = options.sdkEnv;
  }

  async answerQuestions(params: AskUserQuestionParams): Promise<AskUserQuestionResult> {
    const systemPrompt = buildAskUserQuestionSystemPrompt(params.persona);
    const userMessage = buildAskUserQuestionUserMessage(
      params.conversationContext,
      params.questions,
    );

    const response = await this.callWithRetry(
      systemPrompt,
      userMessage,
      AskUserQuestionResponseSchema,
      ASK_USER_QUESTION_OUTPUT_SCHEMA,
      (parsed) =>
        parsed.answers.length === params.questions.length
          ? null
          : `You returned ${parsed.answers.length} answer(s) for ${params.questions.length} question(s). Return exactly one answer per question.`,
    );

    this.trackUsage(response.usage);

    const oracleAnswers = response.parsed_output.answers;
    const answers = Object.fromEntries(
      params.questions.map((q, i) => [q.question, oracleAnswers[i].answer]),
    );

    return {
      answers,
      reasoning: response.parsed_output.reasoning,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    };
  }

  async decideTurnPolicy(params: TurnPolicyParams): Promise<TurnPolicyResult> {
    const systemPrompt = buildTurnPolicySystemPrompt(params.persona, params.originalPrompt);
    const userMessage = buildTurnPolicyUserMessage(params.conversationContext);

    const response = await this.callWithRetry(
      systemPrompt,
      userMessage,
      TurnPolicyResponseSchema,
      TURN_POLICY_OUTPUT_SCHEMA,
    );

    this.trackUsage(response.usage);

    const parsed = response.parsed_output;
    return {
      decision: parsed.decision,
      message: parsed.decision === 'continue' ? parsed.message : undefined,
      reasoning: parsed.reasoning,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    };
  }

  getTotalUsage(): OracleUsageTotal {
    return {
      ...this.totalUsage,
      cost_usd: computeCostUsd(
        this.model,
        this.totalUsage.input_tokens,
        this.totalUsage.output_tokens,
        this.totalUsage.cache_creation_input_tokens,
        this.totalUsage.cache_read_input_tokens,
      ),
    };
  }

  private async callWithRetry<T extends z.ZodType>(
    systemPrompt: string,
    userMessage: string,
    schema: T,
    outputSchema: Record<string, unknown>,
    validate?: (parsed: z.infer<T>) => string | null,
  ): Promise<{
    parsed_output: z.infer<T>;
    usage: OracleUsage;
  }> {
    let lastError: unknown;
    // Appended to the user message on the next attempt when a parsed response
    // fails semantic validation, so the oracle is re-prompted with what went
    // wrong (e.g. an answer-per-option count mismatch). Empty for transport
    // failures, which carry no useful correction.
    let correction = '';
    for (let attempt = 0; attempt < ORACLE_MAX_ATTEMPTS; attempt++) {
      try {
        const { structured, usage } = await this.callModel(
          systemPrompt,
          userMessage + correction,
          outputSchema,
        );
        const parsed = schema.safeParse(structured);
        if (!parsed.success) {
          throw new Error('Oracle returned no structured output');
        }
        if (validate) {
          const problem = validate(parsed.data);
          if (problem) {
            correction = `\n\n## Correction\n${problem}`;
            throw new Error(problem);
          }
        }
        return { parsed_output: parsed.data, usage };
      } catch (err) {
        lastError = err;
        if (attempt === 0 && this.verbose) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[scuttlerun] oracle: first attempt failed (${msg}); retrying with backoff\n`,
          );
        }
        if (attempt < ORACLE_MAX_ATTEMPTS - 1) {
          const exponential = this.baseDelayMs * 2 ** attempt;
          const jitter = Math.random() * this.baseDelayMs;
          await this.sleep(exponential + jitter);
        }
      }
    }
    const lastMsg = lastError instanceof Error ? lastError.message : String(lastError);
    const wrapped = new Error(`Oracle exhausted ${ORACLE_MAX_ATTEMPTS} attempts: ${lastMsg}`);
    if (lastError instanceof Error) {
      (wrapped as Error & { cause?: unknown }).cause = lastError;
    }
    throw wrapped;
  }

  /**
   * One oracle exchange via a one-shot Agent SDK query: no tools, structured
   * output enforced by JSON schema. Returns the structured output (or the
   * result string parsed as JSON when the SDK omits it) plus token usage.
   */
  private async callModel(
    systemPrompt: string,
    userMessage: string,
    outputSchema: Record<string, unknown>,
  ): Promise<{ structured: unknown; usage: OracleUsage }> {
    let structured: unknown;
    let usage: OracleUsage | undefined;
    let sdkError: { subtype: string; errors: string[] } | undefined;

    for await (const message of query({
      prompt: userMessage,
      options: {
        model: this.model,
        env: this.sdkEnv ?? { ...process.env, CLAUDECODE: undefined },
        tools: [],
        maxTurns: ORACLE_MAX_TURNS,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        systemPrompt: [systemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY],
        outputFormat: {
          type: 'json_schema',
          schema: outputSchema,
        },
      },
    })) {
      if (message.type === 'result') {
        usage = message.usage;
        if (message.subtype === 'success') {
          structured = message.structured_output ?? tryParseJson(message.result);
        } else {
          sdkError = {
            subtype: message.subtype,
            errors: (message as { errors?: string[] }).errors ?? [],
          };
        }
      }
    }

    if (sdkError) {
      const detail = sdkError.errors.length > 0 ? sdkError.errors.join('; ') : 'no error details';
      throw new Error(`Oracle SDK call failed (${sdkError.subtype}): ${detail}`);
    }
    if (!usage) {
      throw new Error('Oracle SDK call produced no result message');
    }
    return { structured, usage };
  }

  private trackUsage(usage: OracleUsage): void {
    this.totalUsage.input_tokens += usage.input_tokens;
    this.totalUsage.output_tokens += usage.output_tokens;
    this.totalUsage.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
    this.totalUsage.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
    this.totalUsage.calls += 1;
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function buildAskUserQuestionSystemPrompt(persona: string | undefined): string {
  return `You are simulating a user in a Claude Code session. You must answer
the agent's clarifying questions consistent with the following persona:

${persona ?? 'A helpful user who provides reasonable answers.'}

Given the conversation so far and the questions below, select the most
appropriate answers. Return one entry per question in the answers array,
using the exact question text and the selected option label (or free text
if no option fits). The answers array must have exactly one entry per
question — one per question, never one per option. A question's options are
alternative choices for that single question, not separate questions. For a
multi-select question, still return a single entry whose answer lists the
chosen labels (for example, "A, B"). Provide brief reasoning.`;
}

function buildAskUserQuestionUserMessage(
  context: ConversationEntry[],
  questions: QuestionInput[],
): string {
  const parts: string[] = [];

  if (context.length > 0) {
    parts.push('## Conversation so far\n');
    for (const entry of context) {
      parts.push(`**${entry.role}:** ${entry.text}\n`);
    }
  }

  parts.push('\n## Questions to answer\n');
  for (const q of questions) {
    parts.push(`### ${q.question}`);
    if (q.options.length > 0) {
      parts.push('Options:');
      for (const opt of q.options) {
        parts.push(`- **${opt.label}**: ${opt.description}`);
      }
    }
    if (q.multiSelect) {
      parts.push('(Multiple selections allowed)');
    }
    parts.push('');
  }

  return parts.join('\n');
}

function buildTurnPolicySystemPrompt(persona: string | undefined, originalPrompt: string): string {
  return `You are simulating a user in a Claude Code session. Your persona:

${persona ?? 'A helpful user.'}

The original task was: ${originalPrompt}

Review the conversation so far. Decide whether the user would:
1. Send a follow-up message (task incomplete, needs refinement, or user
   would naturally ask for more)
2. End the session (task is done, or no useful follow-up)

If continuing, write the follow-up message the user would send.`;
}

function buildTurnPolicyUserMessage(context: ConversationEntry[]): string {
  if (context.length === 0) {
    return 'No conversation yet. Should the user follow up or end the session?';
  }

  const parts: string[] = ['## Conversation so far\n'];
  for (const entry of context) {
    parts.push(`**${entry.role}:** ${entry.text}\n`);
  }
  parts.push('\nShould the user send a follow-up message, or is the task complete?');

  return parts.join('\n');
}
