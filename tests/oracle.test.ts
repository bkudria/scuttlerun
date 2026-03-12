import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  Oracle,
  type AskUserQuestionResult,
  type TurnPolicyResult,
} from "../src/oracle.js";

// Mock the Anthropic SDK
const mockParse = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = {
        parse: mockParse,
      };
    },
  };
});

describe("Oracle", () => {
  let oracle: Oracle;

  beforeEach(() => {
    mockParse.mockReset();
    oracle = new Oracle("claude-haiku-4-5");
  });

  describe("answerQuestions", () => {
    it("calls the API with persona, conversation context, and questions", async () => {
      mockParse.mockResolvedValueOnce({
        parsed_output: {
          answers: { "What format?": "JSON" },
          reasoning: "User prefers structured data",
        },
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      const result = await oracle.answerQuestions({
        persona: "You prefer structured data.",
        conversationContext: [
          { role: "user", text: "Help me format data" },
          { role: "assistant", text: "What format do you prefer?" },
        ],
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
      });

      expect(result.answers).toEqual({ "What format?": "JSON" });
      expect(result.reasoning).toBe("User prefers structured data");
      expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 50 });

      // Verify API was called with correct structure
      expect(mockParse).toHaveBeenCalledOnce();
      const callArgs = mockParse.mock.calls[0][0];
      expect(callArgs.model).toBe("claude-haiku-4-5");
      expect(callArgs.system).toContain("You prefer structured data.");
      expect(callArgs.messages[0].role).toBe("user");
    });

    it("retries once on API failure", async () => {
      mockParse
        .mockRejectedValueOnce(new Error("API error"))
        .mockResolvedValueOnce({
          parsed_output: {
            answers: { "Pick one": "A" },
            reasoning: "retry worked",
          },
          usage: { input_tokens: 50, output_tokens: 30 },
        });

      const result = await oracle.answerQuestions({
        persona: "test",
        conversationContext: [],
        questions: [
          {
            question: "Pick one",
            header: "Choice",
            options: [
              { label: "A", description: "Option A" },
              { label: "B", description: "Option B" },
            ],
            multiSelect: false,
          },
        ],
      });

      expect(result.answers).toEqual({ "Pick one": "A" });
      expect(mockParse).toHaveBeenCalledTimes(2);
    });

    it("throws after retry exhaustion", async () => {
      mockParse
        .mockRejectedValueOnce(new Error("fail 1"))
        .mockRejectedValueOnce(new Error("fail 2"));

      await expect(
        oracle.answerQuestions({
          persona: "test",
          conversationContext: [],
          questions: [
            {
              question: "Q",
              header: "H",
              options: [
                { label: "A", description: "a" },
                { label: "B", description: "b" },
              ],
              multiSelect: false,
            },
          ],
        })
      ).rejects.toThrow("fail 2");
    });
  });

  describe("decideTurnPolicy", () => {
    it("returns continue with a follow-up message", async () => {
      mockParse.mockResolvedValueOnce({
        parsed_output: {
          decision: "continue",
          message: "Can you also add error handling?",
          reasoning: "Task is incomplete",
        },
        usage: { input_tokens: 200, output_tokens: 80 },
      });

      const result = await oracle.decideTurnPolicy({
        persona: "A developer",
        originalPrompt: "Write a parser",
        conversationContext: [
          { role: "user", text: "Write a parser" },
          { role: "assistant", text: "Here is a basic parser..." },
        ],
      });

      expect(result.decision).toBe("continue");
      expect(result.message).toBe("Can you also add error handling?");
      expect(result.reasoning).toBe("Task is incomplete");
      expect(result.usage).toEqual({ input_tokens: 200, output_tokens: 80 });
    });

    it("returns end when task is complete", async () => {
      mockParse.mockResolvedValueOnce({
        parsed_output: {
          decision: "end",
          reasoning: "Task completed as requested",
        },
        usage: { input_tokens: 150, output_tokens: 40 },
      });

      const result = await oracle.decideTurnPolicy({
        persona: "A user",
        originalPrompt: "Write a haiku",
        conversationContext: [
          { role: "user", text: "Write a haiku" },
          { role: "assistant", text: "Ocean waves crash\n..." },
        ],
      });

      expect(result.decision).toBe("end");
      expect(result.message).toBeUndefined();
    });

    it("retries once on failure", async () => {
      mockParse
        .mockRejectedValueOnce(new Error("network"))
        .mockResolvedValueOnce({
          parsed_output: { decision: "end", reasoning: "done" },
          usage: { input_tokens: 100, output_tokens: 30 },
        });

      const result = await oracle.decideTurnPolicy({
        persona: "test",
        originalPrompt: "test",
        conversationContext: [],
      });

      expect(result.decision).toBe("end");
      expect(mockParse).toHaveBeenCalledTimes(2);
    });
  });

  describe("usage tracking", () => {
    it("accumulates usage across calls", async () => {
      mockParse
        .mockResolvedValueOnce({
          parsed_output: { answers: { Q: "A" }, reasoning: "r" },
          usage: { input_tokens: 100, output_tokens: 50 },
        })
        .mockResolvedValueOnce({
          parsed_output: { decision: "end", reasoning: "done" },
          usage: { input_tokens: 200, output_tokens: 80 },
        });

      await oracle.answerQuestions({
        persona: "t",
        conversationContext: [],
        questions: [
          {
            question: "Q",
            header: "H",
            options: [
              { label: "A", description: "a" },
              { label: "B", description: "b" },
            ],
            multiSelect: false,
          },
        ],
      });

      await oracle.decideTurnPolicy({
        persona: "t",
        originalPrompt: "t",
        conversationContext: [],
      });

      const total = oracle.getTotalUsage();
      expect(total.input_tokens).toBe(300);
      expect(total.output_tokens).toBe(130);
      expect(total.calls).toBe(2);
    });
  });
});
