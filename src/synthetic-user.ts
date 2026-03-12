import type {
  Oracle,
  ConversationEntry,
  QuestionInput,
} from "./oracle.js";
import type { UserConfig } from "./config.js";

export interface CanUseToolResult {
  behavior: "allow";
  updatedInput: {
    questions: QuestionInput[];
    answers: Record<string, string>;
  };
  oracleResponse: {
    answers: Record<string, string>;
    reasoning: string;
  };
}

export interface TurnDecision {
  decision: "continue" | "end";
  message?: string;
  reasoning?: string;
}

export class SyntheticUser {
  private oracle: Oracle;
  private config: UserConfig;
  private originalPrompt: string;
  private conversationBuffer: ConversationEntry[] = [];
  private userTurnCount = 0;

  constructor(
    oracle: Oracle,
    config: UserConfig,
    originalPrompt: string,
  ) {
    this.oracle = oracle;
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
  ): Promise<CanUseToolResult> {
    const context = this.getRecentContext();

    const result = await this.oracle.answerQuestions({
      persona: this.config.persona,
      conversationContext: context,
      questions: input.questions,
    });

    return {
      behavior: "allow",
      updatedInput: {
        questions: input.questions,
        answers: result.answers,
      },
      oracleResponse: {
        answers: result.answers,
        reasoning: result.reasoning,
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

    if (result.decision === "continue") {
      this.userTurnCount++;
    }

    return {
      decision: result.decision,
      message: result.message,
      reasoning: result.reasoning,
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
