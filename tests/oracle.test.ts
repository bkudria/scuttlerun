import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Oracle, AskUserQuestionInputSchema } from '../src/oracle.js';
import type { Query } from '@anthropic-ai/claude-agent-sdk';

// Mock the Agent SDK
vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const actual = await vi.importActual<typeof import('@anthropic-ai/claude-agent-sdk')>(
    '@anthropic-ai/claude-agent-sdk',
  );
  return {
    ...actual,
    query: vi.fn(),
  };
});

import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
const mockQuery = vi.mocked(query);

interface MockUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** One-shot successful oracle query: a result message carrying structured output. */
function oracleResult(structured: unknown, usage: MockUsage): Query {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'result',
        subtype: 'success',
        structured_output: structured,
        result: structured == null ? 'no structured output here' : JSON.stringify(structured),
        usage,
        total_cost_usd: 0,
      };
    },
  } as unknown as Query;
}

/** Successful result message with no structured_output, only a raw result string. */
function oracleRawResult(resultText: string, usage: MockUsage): Query {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'result',
        subtype: 'success',
        structured_output: null,
        result: resultText,
        usage,
        total_cost_usd: 0,
      };
    },
  } as unknown as Query;
}

/** SDK-level error result (e.g. error_during_execution). */
function oracleErrorResult(subtype: string, errors: string[]): Query {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'result',
        subtype,
        errors,
        usage: { input_tokens: 0, output_tokens: 0 },
        total_cost_usd: 0,
      };
    },
  } as unknown as Query;
}

/** Query whose iteration throws (transport-level failure). */
function oracleTransportFailure(error: unknown): Query {
  return {
    // eslint-disable-next-line require-yield
    async *[Symbol.asyncIterator]() {
      throw error;
    },
  } as unknown as Query;
}

const USAGE = { input_tokens: 100, output_tokens: 50 };

function singleQuestion(overrides: Partial<Parameters<Oracle['answerQuestions']>[0]> = {}) {
  return {
    persona: 'test',
    conversationContext: [],
    questions: [
      {
        question: 'Q',
        header: 'H',
        options: [
          { label: 'A', description: 'a' },
          { label: 'B', description: 'b' },
        ],
        multiSelect: false,
      },
    ],
    ...overrides,
  };
}

function answersOutput(question = 'Q', answer = 'A', reasoning = 'r') {
  return { answers: [{ question, answer }], reasoning };
}

describe('Oracle', () => {
  let oracle: Oracle;

  beforeEach(() => {
    mockQuery.mockReset();
    oracle = new Oracle('claude-haiku-4-5');
  });

  describe('SDK invocation contract', () => {
    it('runs a one-shot Agent SDK query with no tools and structured output', async () => {
      mockQuery.mockReturnValueOnce(oracleResult(answersOutput(), USAGE));

      await oracle.answerQuestions(singleQuestion());

      expect(mockQuery).toHaveBeenCalledOnce();
      const { options } = mockQuery.mock.calls[0][0] as {
        options: Record<string, unknown>;
      };
      expect(options.model).toBe('claude-haiku-4-5');
      expect(options.tools).toEqual([]);
      expect(options.persistSession).toBe(false);
      expect(options.permissionMode).toBe('bypassPermissions');
      expect(options.allowDangerouslySkipPermissions).toBe(true);
      const outputFormat = options.outputFormat as { type: string; schema: unknown };
      expect(outputFormat.type).toBe('json_schema');
      expect(outputFormat.schema).toBeDefined();
    });

    it('passes the system prompt with the dynamic boundary appended', async () => {
      mockQuery.mockReturnValueOnce(oracleResult(answersOutput(), USAGE));

      await oracle.answerQuestions(singleQuestion({ persona: 'PERSONA_MARKER' }));

      const { options } = mockQuery.mock.calls[0][0] as unknown as {
        options: { systemPrompt: [string, unknown] };
      };
      expect(options.systemPrompt[0]).toContain('PERSONA_MARKER');
      expect(options.systemPrompt[1]).toBe(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    });

    it('defaults the query env to process.env with CLAUDECODE unset', async () => {
      process.env.CLAUDECODE = '1';
      process.env.SCUTTLERUN_TEST_VAR = 'preserved';
      try {
        mockQuery.mockReturnValueOnce(oracleResult(answersOutput(), USAGE));

        await oracle.answerQuestions(singleQuestion());

        const { options } = mockQuery.mock.calls[0][0] as {
          options: { env: Record<string, string | undefined> };
        };
        expect(options.env.CLAUDECODE).toBeUndefined();
        expect(options.env.SCUTTLERUN_TEST_VAR).toBe('preserved');
        expect(process.env.CLAUDECODE).toBe('1');
      } finally {
        delete process.env.CLAUDECODE;
        delete process.env.SCUTTLERUN_TEST_VAR;
      }
    });

    it('passes options.sdkEnv to the query verbatim when provided', async () => {
      const sdkEnv = { ANTHROPIC_API_KEY: undefined, HOME: '/home/user' };
      const o = new Oracle('claude-haiku-4-5', { sdkEnv });
      mockQuery.mockReturnValueOnce(oracleResult(answersOutput(), USAGE));

      await o.answerQuestions(singleQuestion());

      const { options } = mockQuery.mock.calls[0][0] as { options: { env: unknown } };
      expect(options.env).toBe(sdkEnv);
    });

    it('falls back to parsing the raw result string when structured_output is absent', async () => {
      mockQuery.mockReturnValueOnce(oracleRawResult(JSON.stringify(answersOutput()), USAGE));

      const result = await oracle.answerQuestions(singleQuestion());
      expect(result.answers).toEqual({ Q: 'A' });
    });
  });

  describe('answerQuestions', () => {
    it('calls the oracle with persona, conversation context, and questions', async () => {
      mockQuery.mockReturnValueOnce(
        oracleResult(
          {
            answers: [{ question: 'What format?', answer: 'JSON' }],
            reasoning: 'User prefers structured data',
          },
          USAGE,
        ),
      );

      const result = await oracle.answerQuestions({
        persona: 'You prefer structured data.',
        conversationContext: [
          { role: 'user', text: 'Help me format data' },
          { role: 'assistant', text: 'What format do you prefer?' },
        ],
        questions: [
          {
            question: 'What format?',
            header: 'Format',
            options: [
              { label: 'JSON', description: 'JavaScript Object Notation' },
              { label: 'YAML', description: "YAML Ain't Markup Language" },
            ],
            multiSelect: false,
          },
        ],
      });

      expect(result.answers).toEqual({ 'What format?': 'JSON' });
      expect(result.reasoning).toBe('User prefers structured data');
      expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 50 });

      const call = mockQuery.mock.calls[0][0] as unknown as {
        prompt: string;
        options: { model: string; systemPrompt: [string, unknown] };
      };
      expect(call.options.model).toBe('claude-haiku-4-5');
      expect(call.options.systemPrompt[0]).toContain('You prefer structured data.');
      expect(call.prompt).toContain('What format?');
      expect(call.prompt).toContain('Help me format data');
    });

    it('retries once on transport failure', async () => {
      mockQuery
        .mockReturnValueOnce(oracleTransportFailure(new Error('API error')))
        .mockReturnValueOnce(oracleResult(answersOutput('Pick one', 'A', 'retry worked'), USAGE));

      const result = await oracle.answerQuestions(
        singleQuestion({
          questions: [
            {
              question: 'Pick one',
              header: 'Choice',
              options: [
                { label: 'A', description: 'a' },
                { label: 'B', description: 'b' },
              ],
              multiSelect: false,
            },
          ],
        }),
      );

      expect(result.answers).toEqual({ 'Pick one': 'A' });
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('retries on an SDK error result subtype', async () => {
      const o = new Oracle('claude-haiku-4-5', { sleep: () => Promise.resolve() });
      mockQuery
        .mockReturnValueOnce(oracleErrorResult('error_during_execution', ['model exploded']))
        .mockReturnValueOnce(oracleResult(answersOutput(), USAGE));

      const result = await o.answerQuestions(singleQuestion());

      expect(result.answers).toEqual({ Q: 'A' });
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('retries when the structured output fails schema validation', async () => {
      const o = new Oracle('claude-haiku-4-5', { sleep: () => Promise.resolve() });
      mockQuery
        .mockReturnValueOnce(oracleResult({ wrong: 'shape' }, USAGE))
        .mockReturnValueOnce(oracleResult(answersOutput(), USAGE));

      const result = await o.answerQuestions(singleQuestion());

      expect(result.answers).toEqual({ Q: 'A' });
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('throws after retry exhaustion', async () => {
      const o = new Oracle('claude-haiku-4-5', { sleep: () => Promise.resolve() });
      mockQuery
        .mockReturnValueOnce(oracleTransportFailure(new Error('fail 1')))
        .mockReturnValueOnce(oracleTransportFailure(new Error('fail 2')))
        .mockReturnValueOnce(oracleTransportFailure(new Error('fail 3')))
        .mockReturnValueOnce(oracleTransportFailure(new Error('fail 4')));

      await expect(o.answerQuestions(singleQuestion())).rejects.toThrow(
        /exhausted.*4 attempts.*fail 4/,
      );
      expect(mockQuery).toHaveBeenCalledTimes(4);
    });

    it('keys answers by the input question text even when the oracle paraphrases the question', async () => {
      mockQuery.mockReturnValueOnce(
        oracleResult(
          {
            answers: [{ question: 'Which option do you want?', answer: 'Skip' }],
            reasoning: 'r',
          },
          { input_tokens: 10, output_tokens: 5 },
        ),
      );

      const result = await oracle.answerQuestions({
        persona: 'p',
        conversationContext: [],
        questions: [
          {
            question: 'How do you want to proceed?',
            header: 'Proceed',
            options: [
              { label: 'Continue', description: 'keep going' },
              { label: 'Skip', description: 'skip it' },
            ],
            multiSelect: false,
          },
        ],
      });

      expect(result.answers).toEqual({ 'How do you want to proceed?': 'Skip' });
    });

    it('self-corrects a question/answer count mismatch by retrying with corrective feedback', async () => {
      const o = new Oracle('claude-haiku-4-5', { sleep: () => Promise.resolve() });
      mockQuery
        .mockReturnValueOnce(
          oracleResult(
            {
              answers: [
                { question: 'Pick', answer: 'A' },
                { question: 'Pick', answer: 'B' },
              ],
              reasoning: 'over-answered one entry per option',
            },
            { input_tokens: 10, output_tokens: 5 },
          ),
        )
        .mockReturnValueOnce(
          oracleResult(
            { answers: [{ question: 'Pick', answer: 'A' }], reasoning: 'corrected to one entry' },
            { input_tokens: 12, output_tokens: 6 },
          ),
        );

      const result = await o.answerQuestions(
        singleQuestion({
          questions: [
            {
              question: 'Pick',
              header: 'Choice',
              options: [
                { label: 'A', description: 'a' },
                { label: 'B', description: 'b' },
              ],
              multiSelect: false,
            },
          ],
        }),
      );

      expect(result.answers).toEqual({ Pick: 'A' });
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const retryPrompt = (mockQuery.mock.calls[1][0] as { prompt: string }).prompt;
      expect(retryPrompt).toContain('Correction');
      expect(retryPrompt).toContain('Return exactly one answer per question');
    });

    it('retries a count mismatch and fails as a runtime error only after exhausting attempts', async () => {
      const o = new Oracle('claude-haiku-4-5', { sleep: () => Promise.resolve() });
      const overAnswered = {
        answers: [
          { question: 'First?', answer: 'Yes' },
          { question: 'First?', answer: 'No' },
        ],
        reasoning: 'r',
      };
      for (let i = 0; i < 4; i++) {
        mockQuery.mockReturnValueOnce(
          oracleResult(overAnswered, { input_tokens: 10, output_tokens: 5 }),
        );
      }

      await expect(
        o.answerQuestions(
          singleQuestion({
            questions: [
              {
                question: 'First?',
                header: 'First',
                options: [
                  { label: 'Yes', description: 'y' },
                  { label: 'No', description: 'n' },
                ],
                multiSelect: false,
              },
            ],
          }),
        ),
      ).rejects.toThrow(/exhausted.*4 attempts.*2 answer/i);
      expect(mockQuery).toHaveBeenCalledTimes(4);
    });
  });

  describe('decideTurnPolicy', () => {
    it('returns continue with a follow-up message', async () => {
      mockQuery.mockReturnValueOnce(
        oracleResult(
          {
            decision: 'continue',
            message: 'Can you also add error handling?',
            reasoning: 'Task is incomplete',
          },
          { input_tokens: 200, output_tokens: 80 },
        ),
      );

      const result = await oracle.decideTurnPolicy({
        persona: 'A developer',
        originalPrompt: 'Write a parser',
        conversationContext: [
          { role: 'user', text: 'Write a parser' },
          { role: 'assistant', text: 'Here is a basic parser...' },
        ],
      });

      expect(result.decision).toBe('continue');
      expect(result.message).toBe('Can you also add error handling?');
      expect(result.reasoning).toBe('Task is incomplete');
      expect(result.usage).toEqual({ input_tokens: 200, output_tokens: 80 });
    });

    it('returns end when task is complete', async () => {
      mockQuery.mockReturnValueOnce(
        oracleResult(
          { decision: 'end', reasoning: 'Task completed as requested' },
          { input_tokens: 150, output_tokens: 40 },
        ),
      );

      const result = await oracle.decideTurnPolicy({
        persona: 'A user',
        originalPrompt: 'Write a haiku',
        conversationContext: [
          { role: 'user', text: 'Write a haiku' },
          { role: 'assistant', text: 'Ocean waves crash\n...' },
        ],
      });

      expect(result.decision).toBe('end');
      expect(result.message).toBeUndefined();
    });

    it('retries once on failure', async () => {
      mockQuery
        .mockReturnValueOnce(oracleTransportFailure(new Error('network')))
        .mockReturnValueOnce(
          oracleResult(
            { decision: 'end', reasoning: 'done' },
            { input_tokens: 100, output_tokens: 30 },
          ),
        );

      const result = await oracle.decideTurnPolicy({
        persona: 'test',
        originalPrompt: 'test',
        conversationContext: [],
      });

      expect(result.decision).toBe('end');
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });
  });

  describe('callWithRetry', () => {
    it('throws when no structured output can be recovered', async () => {
      const o = new Oracle('claude-haiku-4-5', { sleep: () => Promise.resolve() });
      mockQuery.mockImplementation(() =>
        oracleRawResult('plain text, not json', { input_tokens: 50, output_tokens: 10 }),
      );

      await expect(o.answerQuestions(singleQuestion())).rejects.toThrow(
        /Oracle returned no structured output/,
      );
    });

    it('throws when the query completes without a result message', async () => {
      const o = new Oracle('claude-haiku-4-5', { sleep: () => Promise.resolve() });
      const emptyQuery = {
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 's-none' };
        },
      } as unknown as Query;
      mockQuery.mockImplementation(() => emptyQuery);

      await expect(o.answerQuestions(singleQuestion())).rejects.toThrow(
        /produced no result message/,
      );
    });

    it('reports "no error details" when the SDK error result carries none', async () => {
      const o = new Oracle('claude-haiku-4-5', { sleep: () => Promise.resolve() });
      const bareError = {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'result',
            subtype: 'error_max_turns',
            usage: { input_tokens: 0, output_tokens: 0 },
            total_cost_usd: 0,
          };
        },
      } as unknown as Query;
      mockQuery.mockImplementation(() => bareError);

      await expect(o.answerQuestions(singleQuestion())).rejects.toThrow(
        /error_max_turns.*no error details/,
      );
    });

    it('surfaces SDK error details when the result subtype is an error', async () => {
      const o = new Oracle('claude-haiku-4-5', { sleep: () => Promise.resolve() });
      mockQuery.mockImplementation(() =>
        oracleErrorResult('error_during_execution', ['boom detail']),
      );

      await expect(o.answerQuestions(singleQuestion())).rejects.toThrow(
        /error_during_execution.*boom detail/,
      );
    });

    it('sleeps between attempts with exponential backoff', async () => {
      const sleepCalls: number[] = [];
      const fastSleep = (ms: number) => {
        sleepCalls.push(ms);
        return Promise.resolve();
      };
      const o = new Oracle('claude-haiku-4-5', { sleep: fastSleep });

      mockQuery
        .mockReturnValueOnce(oracleTransportFailure(new Error('e1')))
        .mockReturnValueOnce(oracleTransportFailure(new Error('e2')))
        .mockReturnValueOnce(oracleTransportFailure(new Error('e3')))
        .mockReturnValueOnce(oracleTransportFailure(new Error('e4')));

      await expect(o.answerQuestions(singleQuestion())).rejects.toThrow();

      expect(sleepCalls).toHaveLength(3);
      expect(sleepCalls[0]).toBeLessThan(sleepCalls[1]);
      expect(sleepCalls[1]).toBeLessThan(sleepCalls[2]);
    });

    it('logs first failure to stderr when verbose', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const o = new Oracle('claude-haiku-4-5', {
        verbose: true,
        sleep: () => Promise.resolve(),
      });

      mockQuery
        .mockReturnValueOnce(oracleTransportFailure(new Error('first failure here')))
        .mockReturnValueOnce(oracleResult(answersOutput(), { input_tokens: 10, output_tokens: 5 }));

      await o.answerQuestions(singleQuestion());

      expect(stderrSpy).toHaveBeenCalled();
      const logged = stderrSpy.mock.calls.flat().join(' ');
      expect(logged).toContain('first failure here');
      stderrSpy.mockRestore();
    });

    it('does not log when verbose is false', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const o = new Oracle('claude-haiku-4-5', { sleep: () => Promise.resolve() });

      mockQuery
        .mockReturnValueOnce(oracleTransportFailure(new Error('silent failure')))
        .mockReturnValueOnce(oracleResult(answersOutput(), { input_tokens: 10, output_tokens: 5 }));

      await o.answerQuestions(singleQuestion());

      expect(stderrSpy).not.toHaveBeenCalled();
      stderrSpy.mockRestore();
    });

    it('wraps exhausted error with attempt count and underlying message', async () => {
      const o = new Oracle('claude-haiku-4-5', { sleep: () => Promise.resolve() });
      mockQuery
        .mockReturnValueOnce(oracleTransportFailure(new Error('e1')))
        .mockReturnValueOnce(oracleTransportFailure(new Error('e2')))
        .mockReturnValueOnce(oracleTransportFailure(new Error('e3')))
        .mockReturnValueOnce(oracleTransportFailure(new Error('final boom')));

      let caught: unknown;
      try {
        await o.answerQuestions(singleQuestion());
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(Error);
      const err = caught as Error & { cause?: unknown };
      expect(err.message).toMatch(/exhausted.*4 attempts/);
      expect(err.message).toContain('final boom');
      expect(err.cause).toBeInstanceOf(Error);
      expect((err.cause as Error).message).toBe('final boom');
    });

    it('logs first failure to stderr when verbose with non-Error throw', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const o = new Oracle('claude-haiku-4-5', {
        verbose: true,
        sleep: () => Promise.resolve(),
      });

      mockQuery
        .mockReturnValueOnce(oracleTransportFailure('string-not-error'))
        .mockReturnValueOnce(oracleResult(answersOutput(), { input_tokens: 10, output_tokens: 5 }));

      await o.answerQuestions(singleQuestion());

      const logged = stderrSpy.mock.calls.flat().join(' ');
      expect(logged).toContain('string-not-error');
      stderrSpy.mockRestore();
    });

    it('wraps exhausted error when all attempts throw non-Error values', async () => {
      const o = new Oracle('claude-haiku-4-5', { sleep: () => Promise.resolve() });
      mockQuery
        .mockReturnValueOnce(oracleTransportFailure('e1'))
        .mockReturnValueOnce(oracleTransportFailure('e2'))
        .mockReturnValueOnce(oracleTransportFailure('e3'))
        .mockReturnValueOnce(oracleTransportFailure('final-string'));

      let caught: unknown;
      try {
        await o.answerQuestions(singleQuestion());
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(Error);
      const err = caught as Error & { cause?: unknown };
      expect(err.message).toMatch(/exhausted.*4 attempts/);
      expect(err.message).toContain('final-string');
      expect(err.cause).toBeUndefined();
    });
  });

  describe('message building', () => {
    it('handles questions with no options', async () => {
      mockQuery.mockReturnValueOnce(
        oracleResult(
          {
            answers: [{ question: 'What name?', answer: 'Ocean' }],
            reasoning: 'user chose a name',
          },
          { input_tokens: 80, output_tokens: 40 },
        ),
      );

      await oracle.answerQuestions({
        persona: 'test',
        conversationContext: [],
        questions: [
          {
            question: 'What name?',
            header: 'Name',
            options: [],
            multiSelect: false,
          },
        ],
      });

      const prompt = (mockQuery.mock.calls[0][0] as { prompt: string }).prompt;
      expect(prompt).toContain('What name?');
      expect(prompt).not.toContain('Options:');
    });

    it('includes multiSelect label in user message', async () => {
      mockQuery.mockReturnValueOnce(
        oracleResult(
          { answers: [{ question: 'Pick', answer: 'A, B' }], reasoning: 'both needed' },
          USAGE,
        ),
      );

      await oracle.answerQuestions({
        persona: 'test',
        conversationContext: [],
        questions: [
          {
            question: 'Pick',
            header: 'Multi',
            options: [
              { label: 'A', description: 'a' },
              { label: 'B', description: 'b' },
            ],
            multiSelect: true,
          },
        ],
      });

      const prompt = (mockQuery.mock.calls[0][0] as { prompt: string }).prompt;
      expect(prompt).toContain('Multiple selections allowed');
    });
  });

  describe('system prompt', () => {
    it('instructs the oracle to return one answer per question, never one per option', async () => {
      mockQuery.mockReturnValueOnce(
        oracleResult(answersOutput(), { input_tokens: 10, output_tokens: 5 }),
      );

      await oracle.answerQuestions(singleQuestion());

      const { options } = mockQuery.mock.calls[0][0] as unknown as {
        options: { systemPrompt: [string, unknown] };
      };
      expect(options.systemPrompt[0]).toContain('never one per option');
      expect(options.systemPrompt[0]).toContain('multi-select');
    });

    it('hands decideTurnPolicy a single-object output schema (the SDK rejects top-level anyOf)', async () => {
      mockQuery.mockReturnValueOnce(oracleResult({ decision: 'end', reasoning: 'done' }, USAGE));

      await oracle.decideTurnPolicy({
        persona: 'p',
        originalPrompt: 'task',
        conversationContext: [],
      });

      const { options } = mockQuery.mock.calls[0][0] as {
        options: { outputFormat: { schema: Record<string, unknown> } };
      };
      const schema = options.outputFormat.schema;
      expect(schema.type).toBe('object');
      expect(schema.anyOf).toBeUndefined();
      const properties = schema.properties as Record<string, unknown>;
      expect(Object.keys(properties).sort()).toEqual(['decision', 'message', 'reasoning']);
      expect(schema.required).toEqual(['decision', 'reasoning']);
    });

    it('includes persona and original prompt on decideTurnPolicy', async () => {
      mockQuery.mockReturnValueOnce(oracleResult({ decision: 'end', reasoning: 'done' }, USAGE));

      await oracle.decideTurnPolicy({
        persona: 'PERSONA_MARKER',
        originalPrompt: 'ORIGINAL_PROMPT_MARKER',
        conversationContext: [],
      });

      const { options } = mockQuery.mock.calls[0][0] as unknown as {
        options: { systemPrompt: [string, unknown] };
      };
      expect(options.systemPrompt[0]).toContain('PERSONA_MARKER');
      expect(options.systemPrompt[0]).toContain('ORIGINAL_PROMPT_MARKER');
    });
  });

  describe('usage tracking', () => {
    it('accumulates usage across calls', async () => {
      mockQuery
        .mockReturnValueOnce(
          oracleResult(answersOutput(), { input_tokens: 100, output_tokens: 50 }),
        )
        .mockReturnValueOnce(
          oracleResult(
            { decision: 'end', reasoning: 'done' },
            { input_tokens: 200, output_tokens: 80 },
          ),
        );

      await oracle.answerQuestions(singleQuestion());
      await oracle.decideTurnPolicy({
        persona: 't',
        originalPrompt: 't',
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

    it('accumulates cache_creation_input_tokens and cache_read_input_tokens across calls', async () => {
      mockQuery
        .mockReturnValueOnce(
          oracleResult(answersOutput(), {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 800,
          }),
        )
        .mockReturnValueOnce(
          oracleResult(
            { decision: 'end', reasoning: 'done' },
            {
              input_tokens: 150,
              output_tokens: 30,
              cache_creation_input_tokens: 50,
              cache_read_input_tokens: 1200,
            },
          ),
        );

      await oracle.answerQuestions(singleQuestion());
      await oracle.decideTurnPolicy({
        persona: 't',
        originalPrompt: 't',
        conversationContext: [],
      });

      const total = oracle.getTotalUsage();
      expect(total.cache_creation_input_tokens).toBe(250);
      expect(total.cache_read_input_tokens).toBe(2000);
    });

    it('reflects cache pricing in cost_usd when cache tokens are present', async () => {
      mockQuery.mockReturnValueOnce(
        oracleResult(answersOutput(), {
          input_tokens: 100_000,
          output_tokens: 50_000,
          cache_creation_input_tokens: 200_000,
          cache_read_input_tokens: 800_000,
        }),
      );

      await oracle.answerQuestions(singleQuestion());

      // haiku-4-5: $1/MTok input, $5/MTok output, $1.25/MTok cache_creation, $0.10/MTok cache_read
      // 100k * 1 + 50k * 5 + 200k * 1.25 + 800k * 0.10 = 0.1 + 0.25 + 0.25 + 0.08 = 0.68
      const total = oracle.getTotalUsage();
      expect(total.cost_usd).toBeCloseTo(0.68, 6);
    });

    it('treats missing cache fields as zero', async () => {
      mockQuery.mockReturnValueOnce(
        oracleResult(answersOutput(), { input_tokens: 100, output_tokens: 50 }),
      );

      await oracle.answerQuestions(singleQuestion());

      const total = oracle.getTotalUsage();
      expect(total.cache_creation_input_tokens).toBe(0);
      expect(total.cache_read_input_tokens).toBe(0);
      // 100 * 1/1M + 50 * 5/1M = 0.0001 + 0.00025 = 0.00035
      expect(total.cost_usd).toBeCloseTo(0.00035, 8);
    });
  });
});

describe('AskUserQuestionInputSchema bounds', () => {
  function makeQuestion(optionCount: number) {
    return {
      question: 'Q?',
      header: 'H',
      options: Array.from({ length: optionCount }, (_, i) => ({
        label: `L${i}`,
        description: `D${i}`,
      })),
      multiSelect: false,
    };
  }

  it('rejects zero questions', () => {
    const result = AskUserQuestionInputSchema.safeParse({ questions: [] });
    expect(result.success).toBe(false);
  });

  it('rejects more than 4 questions', () => {
    const result = AskUserQuestionInputSchema.safeParse({
      questions: Array.from({ length: 5 }, () => makeQuestion(2)),
    });
    expect(result.success).toBe(false);
  });

  it('accepts 1..4 questions', () => {
    for (const n of [1, 2, 3, 4]) {
      const result = AskUserQuestionInputSchema.safeParse({
        questions: Array.from({ length: n }, () => makeQuestion(2)),
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects fewer than 2 options on a question', () => {
    const result = AskUserQuestionInputSchema.safeParse({
      questions: [makeQuestion(1)],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 4 options on a question', () => {
    const result = AskUserQuestionInputSchema.safeParse({
      questions: [makeQuestion(5)],
    });
    expect(result.success).toBe(false);
  });

  it('accepts 2..4 options on a question', () => {
    for (const n of [2, 3, 4]) {
      const result = AskUserQuestionInputSchema.safeParse({
        questions: [makeQuestion(n)],
      });
      expect(result.success).toBe(true);
    }
  });
});
