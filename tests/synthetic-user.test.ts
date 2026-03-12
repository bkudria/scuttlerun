import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyntheticUser } from "../src/synthetic-user.js";
import type { Oracle } from "../src/oracle.js";
import type { UserConfig } from "../src/config.js";

function createMockOracle(): Oracle {
  return {
    answerQuestions: vi.fn(),
    decideTurnPolicy: vi.fn(),
    getTotalUsage: vi.fn().mockReturnValue({ input_tokens: 0, output_tokens: 0, calls: 0 }),
  } as unknown as Oracle;
}

describe("SyntheticUser", () => {
  let oracle: ReturnType<typeof createMockOracle>;
  let userConfig: UserConfig;

  beforeEach(() => {
    oracle = createMockOracle();
    userConfig = {
      persona: "A beginner programmer",
      oracle_model: "claude-haiku-4-5",
      turn_policy: "reactive",
      max_user_turns: 5,
    };
  });

  describe("handleAskUserQuestion", () => {
    it("calls oracle and returns allow with updatedInput and oracleResponse", async () => {
      const mockAnswerQuestions = oracle.answerQuestions as ReturnType<typeof vi.fn>;
      mockAnswerQuestions.mockResolvedValueOnce({
        answers: { "What format?": "JSON" },
        reasoning: "User prefers structured data",
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const user = new SyntheticUser(oracle, userConfig, "test prompt");

      const result = await user.handleAskUserQuestion(
        {
          questions: [
            {
              question: "What format?",
              header: "Format",
              options: [
                { label: "JSON", description: "JavaScript Object Notation" },
                { label: "YAML", description: "YAML Ain't Markup Language" },
              ],
              multiSelect: false,
            },
          ],
        },
      );

      expect(result.behavior).toBe("allow");
      expect(result.updatedInput.answers).toEqual({ "What format?": "JSON" });
      expect(result.oracleResponse).toEqual({
        answers: { "What format?": "JSON" },
        reasoning: "User prefers structured data",
      });
    });
  });

  describe("decideTurn", () => {
    it("returns continue with message and reasoning for reactive policy", async () => {
      const mockDecide = oracle.decideTurnPolicy as ReturnType<typeof vi.fn>;
      mockDecide.mockResolvedValueOnce({
        decision: "continue",
        message: "Can you also add tests?",
        reasoning: "Task needs testing",
        usage: { input_tokens: 200, output_tokens: 80 },
      });

      const user = new SyntheticUser(oracle, userConfig, "Write a parser");
      const result = await user.decideTurn();

      expect(result.decision).toBe("continue");
      expect(result.message).toBe("Can you also add tests?");
      expect(result.reasoning).toBe("Task needs testing");
    });

    it("returns end with reasoning when oracle says end", async () => {
      const mockDecide = oracle.decideTurnPolicy as ReturnType<typeof vi.fn>;
      mockDecide.mockResolvedValueOnce({
        decision: "end",
        reasoning: "Task complete",
        usage: { input_tokens: 150, output_tokens: 40 },
      });

      const user = new SyntheticUser(oracle, userConfig, "Write a haiku");
      const result = await user.decideTurn();

      expect(result.decision).toBe("end");
      expect(result.message).toBeUndefined();
      expect(result.reasoning).toBe("Task complete");
    });

    it("skips oracle for single turn policy", async () => {
      userConfig.turn_policy = "single";
      const user = new SyntheticUser(oracle, userConfig, "test");
      const result = await user.decideTurn();

      expect(result.decision).toBe("end");
      const mockDecide = oracle.decideTurnPolicy as ReturnType<typeof vi.fn>;
      expect(mockDecide).not.toHaveBeenCalled();
    });

    it("ends session when max_user_turns is reached", async () => {
      userConfig.max_user_turns = 2;
      const mockDecide = oracle.decideTurnPolicy as ReturnType<typeof vi.fn>;
      mockDecide.mockResolvedValue({
        decision: "continue",
        message: "more",
        reasoning: "not done",
        usage: { input_tokens: 100, output_tokens: 30 },
      });

      const user = new SyntheticUser(oracle, userConfig, "test");

      // First two calls: continue
      const r1 = await user.decideTurn();
      expect(r1.decision).toBe("continue");
      const r2 = await user.decideTurn();
      expect(r2.decision).toBe("continue");

      // Third call: forced end due to max_user_turns
      const r3 = await user.decideTurn();
      expect(r3.decision).toBe("end");
      // Oracle should NOT have been called a third time
      expect(mockDecide).toHaveBeenCalledTimes(2);
    });
  });

  describe("conversation buffer", () => {
    it("tracks conversation entries added via addMessage", async () => {
      const mockDecide = oracle.decideTurnPolicy as ReturnType<typeof vi.fn>;
      mockDecide.mockResolvedValueOnce({
        decision: "end",
        reasoning: "done",
        usage: { input_tokens: 100, output_tokens: 30 },
      });

      const user = new SyntheticUser(oracle, userConfig, "Write code");
      user.addUserMessage("Write code");
      user.addAssistantMessage("Here is the code...");

      await user.decideTurn();

      // Verify the oracle received the conversation context
      expect(mockDecide).toHaveBeenCalledWith({
        persona: "A beginner programmer",
        originalPrompt: "Write code",
        conversationContext: [
          { role: "user", text: "Write code" },
          { role: "assistant", text: "Here is the code..." },
        ],
      });
    });
  });
});
