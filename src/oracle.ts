import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

// Schema for AskUserQuestion oracle response
const AskUserQuestionResponseSchema = z.object({
  answers: z.record(z.string(), z.string()),
  reasoning: z.string(),
});

// Schema for turn policy oracle response
const TurnPolicyResponseSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("continue"),
    message: z.string(),
    reasoning: z.string(),
  }),
  z.object({
    decision: z.literal("end"),
    reasoning: z.string(),
  }),
]);

export interface ConversationEntry {
  role: "user" | "assistant";
  text: string;
}

export interface QuestionInput {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

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
  decision: "continue" | "end";
  message?: string;
  reasoning: string;
  usage: { input_tokens: number; output_tokens: number };
}

export interface OracleUsageTotal {
  input_tokens: number;
  output_tokens: number;
  calls: number;
}

export class Oracle {
  private client: Anthropic;
  private model: string;
  private totalUsage: OracleUsageTotal = {
    input_tokens: 0,
    output_tokens: 0,
    calls: 0,
  };

  constructor(model: string) {
    this.client = new Anthropic();
    this.model = model;
  }

  async answerQuestions(
    params: AskUserQuestionParams,
  ): Promise<AskUserQuestionResult> {
    const systemPrompt = buildAskUserQuestionSystemPrompt(params.persona);
    const userMessage = buildAskUserQuestionUserMessage(
      params.conversationContext,
      params.questions,
    );

    const response = await this.callWithRetry(systemPrompt, userMessage, AskUserQuestionResponseSchema);

    this.trackUsage(response.usage);

    return {
      answers: response.parsed_output.answers,
      reasoning: response.parsed_output.reasoning,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    };
  }

  async decideTurnPolicy(
    params: TurnPolicyParams,
  ): Promise<TurnPolicyResult> {
    const systemPrompt = buildTurnPolicySystemPrompt(
      params.persona,
      params.originalPrompt,
    );
    const userMessage = buildTurnPolicyUserMessage(params.conversationContext);

    const response = await this.callWithRetry(systemPrompt, userMessage, TurnPolicyResponseSchema);

    this.trackUsage(response.usage);

    const parsed = response.parsed_output;
    return {
      decision: parsed.decision,
      message: parsed.decision === "continue" ? parsed.message : undefined,
      reasoning: parsed.reasoning,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    };
  }

  getTotalUsage(): OracleUsageTotal {
    return { ...this.totalUsage };
  }

  private async callWithRetry<T extends z.ZodType>(
    systemPrompt: string,
    userMessage: string,
    schema: T,
  ): Promise<{ parsed_output: z.infer<T>; usage: { input_tokens: number; output_tokens: number } }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await (this.client.messages as any).parse({
          model: this.model,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: "user" as const, content: userMessage }],
          output_format: schema,
        });
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  private trackUsage(usage: { input_tokens: number; output_tokens: number }): void {
    this.totalUsage.input_tokens += usage.input_tokens;
    this.totalUsage.output_tokens += usage.output_tokens;
    this.totalUsage.calls += 1;
  }
}

function buildAskUserQuestionSystemPrompt(persona: string | undefined): string {
  return `You are simulating a user in a Claude Code session. You must answer
the agent's clarifying questions consistent with the following persona:

${persona ?? "A helpful user who provides reasonable answers."}

Given the conversation so far and the questions below, select the most
appropriate answers. For each question, provide a selected option label
(or free text if no option fits) and brief reasoning.`;
}

function buildAskUserQuestionUserMessage(
  context: ConversationEntry[],
  questions: QuestionInput[],
): string {
  const parts: string[] = [];

  if (context.length > 0) {
    parts.push("## Conversation so far\n");
    for (const entry of context) {
      parts.push(`**${entry.role}:** ${entry.text}\n`);
    }
  }

  parts.push("\n## Questions to answer\n");
  for (const q of questions) {
    parts.push(`### ${q.question}`);
    if (q.options.length > 0) {
      parts.push("Options:");
      for (const opt of q.options) {
        parts.push(`- **${opt.label}**: ${opt.description}`);
      }
    }
    if (q.multiSelect) {
      parts.push("(Multiple selections allowed)");
    }
    parts.push("");
  }

  return parts.join("\n");
}

function buildTurnPolicySystemPrompt(
  persona: string | undefined,
  originalPrompt: string,
): string {
  return `You are simulating a user in a Claude Code session. Your persona:

${persona ?? "A helpful user."}

The original task was: ${originalPrompt}

Review the conversation so far. Decide whether the user would:
1. Send a follow-up message (task incomplete, needs refinement, or user
   would naturally ask for more)
2. End the session (task is done, or no useful follow-up)

If continuing, write the follow-up message the user would send.`;
}

function buildTurnPolicyUserMessage(context: ConversationEntry[]): string {
  if (context.length === 0) {
    return "No conversation yet. Should the user follow up or end the session?";
  }

  const parts: string[] = ["## Conversation so far\n"];
  for (const entry of context) {
    parts.push(`**${entry.role}:** ${entry.text}\n`);
  }
  parts.push("\nShould the user send a follow-up message, or is the task complete?");

  return parts.join("\n");
}
