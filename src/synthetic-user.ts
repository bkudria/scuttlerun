import type {
  Oracle,
  ConversationEntry,
  QuestionInput,
} from "./oracle.js";
import type { EventRecorder } from "./events.js";
import type { UserConfig } from "./config.js";

export interface CanUseToolResult {
  behavior: "allow";
  updatedInput: {
    questions: QuestionInput[];
    answers: Record<string, string>;
  };
}

export interface TurnDecision {
  decision: "continue" | "end";
  message?: string;
}

export class SyntheticUser {
  private oracle: Oracle;
  private recorder: EventRecorder;
  private config: UserConfig;
  private originalPrompt: string;
  private conversationBuffer: ConversationEntry[] = [];
  private userTurnCount = 0;

  constructor(
    oracle: Oracle,
    recorder: EventRecorder,
    config: UserConfig,
    originalPrompt: string,
  ) {
    this.oracle = oracle;
    this.recorder = recorder;
    this.config = config;
    this.originalPrompt = originalPrompt;
  }

  addUserMessage(text: string): void {
    this.conversationBuffer.push({ role: "user", text });
  }

  addAssistantMessage(text: string): void {
    this.conversationBuffer.push({ role: "assistant", text });
  }

  async handleAskUserQuestion(
    input: { questions: QuestionInput[] },
    toolUseId: string,
  ): Promise<CanUseToolResult> {
    const context = this.getRecentContext();

    const result = await this.oracle.answerQuestions({
      persona: this.config.persona,
      conversationContext: context,
      questions: input.questions,
    });

    await this.recorder.writeEvent("ask_user_question", {
      tool_use_id: toolUseId,
      questions: input.questions,
      oracle_response: {
        answers: result.answers,
        reasoning: result.reasoning,
      },
      oracle_model: this.config.oracle_model,
      oracle_usage: result.usage,
    });

    return {
      behavior: "allow",
      updatedInput: {
        questions: input.questions,
        answers: result.answers,
      },
    };
  }

  async decideTurn(): Promise<TurnDecision> {
    // Single-turn mode: always end
    if (this.config.turn_policy === "single") {
      return { decision: "end" };
    }

    // Check max user turns
    if (this.userTurnCount >= this.config.max_user_turns) {
      return { decision: "end" };
    }

    const context = this.getRecentContext();

    const result = await this.oracle.decideTurnPolicy({
      persona: this.config.persona,
      originalPrompt: this.originalPrompt,
      conversationContext: context,
    });

    await this.recorder.writeEvent("turn_policy", {
      decision: result.decision,
      message: result.message,
      reasoning: result.reasoning,
      oracle_model: this.config.oracle_model,
      oracle_usage: result.usage,
    });

    if (result.decision === "continue") {
      this.userTurnCount++;
    }

    return {
      decision: result.decision,
      message: result.message,
    };
  }

  /**
   * Returns the last 10 user/assistant pairs from the conversation buffer.
   * Truncated for oracle context windows.
   */
  private getRecentContext(): ConversationEntry[] {
    // Each "pair" is a user + assistant message = 2 entries
    const maxEntries = 20; // 10 pairs
    if (this.conversationBuffer.length <= maxEntries) {
      return [...this.conversationBuffer];
    }
    return this.conversationBuffer.slice(-maxEntries);
  }
}
