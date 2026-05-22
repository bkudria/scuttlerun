import type { Oracle, ConversationEntry, QuestionInput } from './oracle.js';
import type { UserConfig } from './config.js';

const ORACLE_CONTEXT_ENTRY_LIMIT = 20;

export interface CanUseToolResult {
  behavior: 'allow';
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
  decision: 'continue' | 'end';
  message?: string;
  reasoning?: string;
}

export class SyntheticUser {
  private oracle: Oracle;
  private config: UserConfig;
  private originalPrompt: string;
  private conversationBuffer: ConversationEntry[] = [];
  private userTurnCount = 0;

  constructor(oracle: Oracle, config: UserConfig, originalPrompt: string) {
    this.oracle = oracle;
    this.config = config;
    this.originalPrompt = originalPrompt;
  }

  addUserMessage(text: string): void {
    this.conversationBuffer.push({ role: 'user', text });
  }

  addAssistantMessage(text: string): void {
    this.conversationBuffer.push({ role: 'assistant', text });
  }

  async handleAskUserQuestion(input: { questions: QuestionInput[] }): Promise<CanUseToolResult> {
    const context = this.getRecentContext();

    const result = await this.oracle.answerQuestions({
      persona: this.config.persona,
      conversationContext: context,
      questions: input.questions,
    });

    return {
      behavior: 'allow',
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
    // No follow-ups when max_turns is 0
    if (this.config.max_turns === 0) {
      return { decision: 'end' };
    }

    // Check max turns
    if (this.userTurnCount >= this.config.max_turns) {
      return { decision: 'end' };
    }

    const context = this.getRecentContext();

    const result = await this.oracle.decideTurnPolicy({
      persona: this.config.persona,
      originalPrompt: this.originalPrompt,
      conversationContext: context,
    });

    if (result.decision === 'continue') {
      this.userTurnCount++;
    }

    return {
      decision: result.decision,
      message: result.message,
      reasoning: result.reasoning,
    };
  }

  private getRecentContext(): ConversationEntry[] {
    if (this.conversationBuffer.length <= ORACLE_CONTEXT_ENTRY_LIMIT) {
      return [...this.conversationBuffer];
    }
    return this.conversationBuffer.slice(-ORACLE_CONTEXT_ENTRY_LIMIT);
  }
}
