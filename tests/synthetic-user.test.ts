import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyntheticUser } from "../src/synthetic-user.js";
import type { Oracle } from "../src/oracle.js";
import type { EventRecorder } from "../src/events.js";
import type { UserConfig } from "../src/config.js";

function createMockOracle(): Oracle {
  return {
    answerQuestions: vi.fn(),
    decideTurnPolicy: vi.fn(),
    getTotalUsage: vi.fn().mockReturnValue({ input_tokens: 0, output_tokens: 0, calls: 0 }),
  } as unknown as Oracle;
}

function createMockRecorder(): EventRecorder {
  return {
    writeEvent: vi.fn().mockResolvedValue(undefined),
  } as unknown as EventRecorder;
}

describe("SyntheticUser", () => {
  let oracle: ReturnType<typeof createMockOracle>;
  let recorder: ReturnType<typeof createMockRecorder>;
  let userConfig: UserConfig;

  beforeEach(() => {
    oracle = createMockOracle();
    recorder = createMockRecorder();
    userConfig = {
      persona: "A beginner programmer",
      oracle_model: "claude-haiku-4-5",
      turn_policy: "reactive",
      max_user_turns: 5,
    };
  });

  describe("handleAskUserQuestion", () => {
    it("calls oracle and returns allow with updatedInput", async () => {
      const mockAnswerQuestions = oracle.answerQuestions as ReturnType<typeof vi.fn>;
      mockAnswerQuestions.mockResolvedValueOnce({
        answers: { "What format?": "JSON" },
        reasoning: "User prefers structured data",
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const user = new SyntheticUser(oracle, recorder, userConfig, "test prompt");

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
        "tool-use-123",
      );

      expect(result).toEqual({
        behavior: "allow",
        updatedInput: {
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
          answers: { "What format?": "JSON" },
        },
      });
    });

    it("records an ask_user_question event", async () => {
      const mockAnswerQuestions = oracle.answerQuestions as ReturnType<typeof vi.fn>;
      mockAnswerQuestions.mockResolvedValueOnce({
        answers: { "Q": "A" },
        reasoning: "reason",
        usage: { input_tokens: 50, output_tokens: 30 },
      });

      const user = new SyntheticUser(oracle, recorder, userConfig, "test prompt");
      await user.handleAskUserQuestion(
        { questions: [{ question: "Q", header: "H", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }], multiSelect: false }] },
        "tool-456",
      );

      const writeEvent = recorder.writeEvent as ReturnType<typeof vi.fn>;
      expect(writeEvent).toHaveBeenCalledWith("ask_user_question", {
        tool_use_id: "tool-456",
        questions: expect.any(Array),
        oracle_response: { answers: { Q: "A" }, reasoning: "reason" },
        oracle_model: "claude-haiku-4-5",
        oracle_usage: { input_tokens: 50, output_tokens: 30 },
      });
    });
  });

  describe("decideTurn", () => {
    it("returns continue with message for reactive policy", async () => {
      const mockDecide = oracle.decideTurnPolicy as ReturnType<typeof vi.fn>;
      mockDecide.mockResolvedValueOnce({
        decision: "continue",
        message: "Can you also add tests?",
        reasoning: "Task needs testing",
        usage: { input_tokens: 200, output_tokens: 80 },
      });

      const user = new SyntheticUser(oracle, recorder, userConfig, "Write a parser");
      const result = await user.decideTurn();

      expect(result.decision).toBe("continue");
      expect(result.message).toBe("Can you also add tests?");
    });

    it("returns end when oracle says end", async () => {
      const mockDecide = oracle.decideTurnPolicy as ReturnType<typeof vi.fn>;
      mockDecide.mockResolvedValueOnce({
        decision: "end",
        reasoning: "Task complete",
        usage: { input_tokens: 150, output_tokens: 40 },
      });

      const user = new SyntheticUser(oracle, recorder, userConfig, "Write a haiku");
      const result = await user.decideTurn();

      expect(result.decision).toBe("end");
      expect(result.message).toBeUndefined();
    });

    it("records a turn_policy event", async () => {
      const mockDecide = oracle.decideTurnPolicy as ReturnType<typeof vi.fn>;
      mockDecide.mockResolvedValueOnce({
        decision: "end",
        reasoning: "done",
        usage: { input_tokens: 100, output_tokens: 30 },
      });

      const user = new SyntheticUser(oracle, recorder, userConfig, "test");
      await user.decideTurn();

      const writeEvent = recorder.writeEvent as ReturnType<typeof vi.fn>;
      expect(writeEvent).toHaveBeenCalledWith("turn_policy", {
        decision: "end",
        message: undefined,
        reasoning: "done",
        oracle_model: "claude-haiku-4-5",
        oracle_usage: { input_tokens: 100, output_tokens: 30 },
      });
    });

    it("skips oracle for single turn policy", async () => {
      userConfig.turn_policy = "single";
      const user = new SyntheticUser(oracle, recorder, userConfig, "test");
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

      const user = new SyntheticUser(oracle, recorder, userConfig, "test");

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

      const user = new SyntheticUser(oracle, recorder, userConfig, "Write code");
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
