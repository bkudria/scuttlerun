import { describe, it, expect, vi, beforeEach } from "vitest";
import { Oracle } from "../src/oracle.js";

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
          answers: [{ question: "What format?", answer: "JSON" }],
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
            answers: [{ question: "Pick one", answer: "A" }],
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
      const o = new Oracle("claude-haiku-4-5", { sleep: () => Promise.resolve() });
      mockParse
        .mockRejectedValueOnce(new Error("fail 1"))
        .mockRejectedValueOnce(new Error("fail 2"))
        .mockRejectedValueOnce(new Error("fail 3"))
        .mockRejectedValueOnce(new Error("fail 4"));

      await expect(
        o.answerQuestions({
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
      ).rejects.toThrow(/exhausted.*4 attempts.*fail 4/);
      expect(mockParse).toHaveBeenCalledTimes(4);
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

  describe("callWithRetry", () => {
    it("throws when parsed_output is null", async () => {
      mockParse.mockResolvedValue({
        parsed_output: null,
        usage: { input_tokens: 50, output_tokens: 10 },
      });

      await expect(
        oracle.answerQuestions({
          persona: "test",
          conversationContext: [],
          questions: [
            { question: "Q", header: "H", options: [{ label: "A", description: "a" }], multiSelect: false },
          ],
        }),
      ).rejects.toThrow("Oracle returned no structured output");
    });

    it("sleeps between attempts with exponential backoff", async () => {
      const sleepCalls: number[] = [];
      const fastSleep = (ms: number) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      };
      const o = new Oracle("claude-haiku-4-5", { sleep: fastSleep });

      mockParse
        .mockRejectedValueOnce(new Error("e1"))
        .mockRejectedValueOnce(new Error("e2"))
        .mockRejectedValueOnce(new Error("e3"))
        .mockRejectedValueOnce(new Error("e4"));

      await expect(
        o.answerQuestions({
          persona: "p",
          conversationContext: [],
          questions: [
            { question: "Q", header: "H", options: [{ label: "A", description: "a" }], multiSelect: false },
          ],
        }),
      ).rejects.toThrow();

      expect(sleepCalls).toHaveLength(3);
      expect(sleepCalls[0]).toBeLessThan(sleepCalls[1]);
      expect(sleepCalls[1]).toBeLessThan(sleepCalls[2]);
    });

    it("logs first failure to stderr when verbose", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const o = new Oracle("claude-haiku-4-5", {
        verbose: true,
        sleep: () => Promise.resolve(),
      });

      mockParse
        .mockRejectedValueOnce(new Error("first failure here"))
        .mockResolvedValueOnce({
          parsed_output: {
            answers: [{ question: "Q", answer: "A" }],
            reasoning: "ok",
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        });

      await o.answerQuestions({
        persona: "p",
        conversationContext: [],
        questions: [
          { question: "Q", header: "H", options: [{ label: "A", description: "a" }], multiSelect: false },
        ],
      });

      expect(errorSpy).toHaveBeenCalled();
      const logged = errorSpy.mock.calls.flat().join(" ");
      expect(logged).toContain("first failure here");
      errorSpy.mockRestore();
    });

    it("does not log when verbose is false", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const o = new Oracle("claude-haiku-4-5", { sleep: () => Promise.resolve() });

      mockParse
        .mockRejectedValueOnce(new Error("silent failure"))
        .mockResolvedValueOnce({
          parsed_output: {
            answers: [{ question: "Q", answer: "A" }],
            reasoning: "ok",
          },
          usage: { input_tokens: 10, output_tokens: 5 },
        });

      await o.answerQuestions({
        persona: "p",
        conversationContext: [],
        questions: [
          { question: "Q", header: "H", options: [{ label: "A", description: "a" }], multiSelect: false },
        ],
      });

      expect(errorSpy).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it("wraps exhausted error with attempt count and underlying message", async () => {
      const o = new Oracle("claude-haiku-4-5", { sleep: () => Promise.resolve() });
      mockParse
        .mockRejectedValueOnce(new Error("e1"))
        .mockRejectedValueOnce(new Error("e2"))
        .mockRejectedValueOnce(new Error("e3"))
        .mockRejectedValueOnce(new Error("final boom"));

      let caught: unknown;
      try {
        await o.answerQuestions({
          persona: "p",
          conversationContext: [],
          questions: [
            { question: "Q", header: "H", options: [{ label: "A", description: "a" }], multiSelect: false },
          ],
        });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(Error);
      const err = caught as Error & { cause?: unknown };
      expect(err.message).toMatch(/exhausted.*4 attempts/);
      expect(err.message).toContain("final boom");
      expect(err.cause).toBeInstanceOf(Error);
      expect((err.cause as Error).message).toBe("final boom");
    });
  });

  describe("message building", () => {
    it("handles questions with no options", async () => {
      mockParse.mockResolvedValueOnce({
        parsed_output: {
          answers: [{ question: "What name?", answer: "Ocean" }],
          reasoning: "user chose a name",
        },
        usage: { input_tokens: 80, output_tokens: 40 },
      });

      await oracle.answerQuestions({
        persona: "test",
        conversationContext: [],
        questions: [
          {
            question: "What name?",
            header: "Name",
            options: [],
            multiSelect: false,
          },
        ],
      });

      const userMsg = mockParse.mock.calls[0][0].messages[0].content;
      expect(userMsg).toContain("What name?");
      expect(userMsg).not.toContain("Options:");
    });

    it("includes multiSelect label in user message", async () => {
      mockParse.mockResolvedValueOnce({
        parsed_output: {
          answers: [{ question: "Pick", answer: "A, B" }],
          reasoning: "both needed",
        },
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      await oracle.answerQuestions({
        persona: "test",
        conversationContext: [],
        questions: [
          {
            question: "Pick",
            header: "Multi",
            options: [
              { label: "A", description: "a" },
              { label: "B", description: "b" },
            ],
            multiSelect: true,
          },
        ],
      });

      const userMsg = mockParse.mock.calls[0][0].messages[0].content;
      expect(userMsg).toContain("Multiple selections allowed");
    });
  });

  describe("system prompt", () => {
    it("passes system prompt as a string on answerQuestions", async () => {
      mockParse.mockResolvedValueOnce({
        parsed_output: {
          answers: [{ question: "Q", answer: "A" }],
          reasoning: "r",
        },
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      await oracle.answerQuestions({
        persona: "PERSONA_MARKER",
        conversationContext: [],
        questions: [
          {
            question: "Q",
            header: "H",
            options: [{ label: "A", description: "a" }],
            multiSelect: false,
          },
        ],
      });

      const callArgs = mockParse.mock.calls[0][0];
      expect(typeof callArgs.system).toBe("string");
      expect(callArgs.system).toContain("PERSONA_MARKER");
    });

    it("passes system prompt as a string on decideTurnPolicy", async () => {
      mockParse.mockResolvedValueOnce({
        parsed_output: { decision: "end", reasoning: "done" },
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      await oracle.decideTurnPolicy({
        persona: "PERSONA_MARKER",
        originalPrompt: "ORIGINAL_PROMPT_MARKER",
        conversationContext: [],
      });

      const callArgs = mockParse.mock.calls[0][0];
      expect(typeof callArgs.system).toBe("string");
      expect(callArgs.system).toContain("PERSONA_MARKER");
      expect(callArgs.system).toContain("ORIGINAL_PROMPT_MARKER");
    });
  });

  describe("usage tracking", () => {
    it("accumulates usage across calls", async () => {
      mockParse
        .mockResolvedValueOnce({
          parsed_output: { answers: [{ question: "Q", answer: "A" }], reasoning: "r" },
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
      // Default oracle model is claude-haiku-4-5: $1/MTok input + $5/MTok output
      // 300 input * $1/1M + 130 output * $5/1M = 0.0003 + 0.00065 = 0.00095
      expect(total.cost_usd).toBeCloseTo(0.00095, 8);
    });

    it("accumulates cache_creation_input_tokens and cache_read_input_tokens across calls", async () => {
      mockParse
        .mockResolvedValueOnce({
          parsed_output: { answers: [{ question: "Q", answer: "A" }], reasoning: "r" },
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 800,
          },
        })
        .mockResolvedValueOnce({
          parsed_output: { decision: "end", reasoning: "done" },
          usage: {
            input_tokens: 150,
            output_tokens: 30,
            cache_creation_input_tokens: 50,
            cache_read_input_tokens: 1200,
          },
        });

      await oracle.answerQuestions({
        persona: "t",
        conversationContext: [],
        questions: [
          {
            question: "Q",
            header: "H",
            options: [{ label: "A", description: "a" }],
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
      expect(total.cache_creation_input_tokens).toBe(250);
      expect(total.cache_read_input_tokens).toBe(2000);
    });

    it("reflects cache pricing in cost_usd when cache tokens are present", async () => {
      mockParse.mockResolvedValueOnce({
        parsed_output: { answers: [{ question: "Q", answer: "A" }], reasoning: "r" },
        usage: {
          input_tokens: 100_000,
          output_tokens: 50_000,
          cache_creation_input_tokens: 200_000,
          cache_read_input_tokens: 800_000,
        },
      });

      await oracle.answerQuestions({
        persona: "t",
        conversationContext: [],
        questions: [
          {
            question: "Q",
            header: "H",
            options: [{ label: "A", description: "a" }],
            multiSelect: false,
          },
        ],
      });

      // haiku-4-5: $1/MTok input, $5/MTok output, $1.25/MTok cache_creation, $0.10/MTok cache_read
      // 100k * 1 + 50k * 5 + 200k * 1.25 + 800k * 0.10 = 0.1 + 0.25 + 0.25 + 0.08 = 0.68
      const total = oracle.getTotalUsage();
      expect(total.cost_usd).toBeCloseTo(0.68, 6);
    });

    it("treats missing cache fields as zero", async () => {
      mockParse.mockResolvedValueOnce({
        parsed_output: { answers: [{ question: "Q", answer: "A" }], reasoning: "r" },
        usage: { input_tokens: 100, output_tokens: 50 },
      });

      await oracle.answerQuestions({
        persona: "t",
        conversationContext: [],
        questions: [
          {
            question: "Q",
            header: "H",
            options: [{ label: "A", description: "a" }],
            multiSelect: false,
          },
        ],
      });

      const total = oracle.getTotalUsage();
      expect(total.cache_creation_input_tokens).toBe(0);
      expect(total.cache_read_input_tokens).toBe(0);
      // 100 * 1/1M + 50 * 5/1M = 0.0001 + 0.00025 = 0.00035
      expect(total.cost_usd).toBeCloseTo(0.00035, 8);
    });
  });
});
