import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { handleMessage, newSessionState, type SessionState } from '../src/session-loop.js';
import { parseSessionConfig } from '../src/config.js';
import type { Oracle } from '../src/oracle.js';
import { SyntheticUser } from '../src/synthetic-user.js';
import { EXIT_SUCCESS } from '../src/exit-codes.js';

function sdkMessage(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage;
}

function assistantToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): SDKMessage {
  return sdkMessage({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    parent_tool_use_id: null,
    ...extra,
  });
}

function toolResultMessage(
  blocks: unknown[] | string,
  extra: Record<string, unknown> = {},
): SDKMessage {
  return sdkMessage({
    type: 'user',
    message: { role: 'user', content: blocks },
    parent_tool_use_id: null,
    ...extra,
  });
}

describe('handleMessage', () => {
  let output: string;
  let state: SessionState;
  const originalWrite = process.stdout.write;

  function conversation(): Array<Record<string, unknown>> {
    return parseYaml('conversation:\n' + output).conversation ?? [];
  }

  beforeEach(() => {
    output = '';
    process.stdout.write = ((chunk: string) => {
      output += chunk;
      return true;
    }) as typeof process.stdout.write;
    state = newSessionState({
      config: parseSessionConfig({ prompt: 'p' }),
      configPaths: ['/tmp/session.yaml'],
      projectDir: '/tmp/project',
      sandboxHome: undefined,
      claudeDir: undefined,
      oracle: {} as Oracle,
    });
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  describe('tool entries', () => {
    it('gives each tool entry the next id, in call order', async () => {
      await handleMessage(assistantToolUse('toolu_a', 'Bash', { command: 'ls' }), state);
      await handleMessage(assistantToolUse('toolu_b', 'Read', { file_path: '/tmp/x' }), state);

      expect(conversation()).toEqual([
        { tool: 'Bash', id: 1, command: 'ls' },
        { tool: 'Read', id: 2, path: '/tmp/x' },
      ]);
    });
  });

  describe('result entries', () => {
    it('writes a result entry per tool_result block, linked to its call by id', async () => {
      await handleMessage(assistantToolUse('toolu_a', 'Bash', { command: 'a' }), state);
      await handleMessage(assistantToolUse('toolu_b', 'Bash', { command: 'b' }), state);
      await handleMessage(
        toolResultMessage([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_b',
            is_error: true,
            content: 'Exit code 1\nb',
          },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_a',
            is_error: true,
            content: 'Exit code 1\na',
          },
        ]),
        state,
      );

      expect(conversation()).toEqual([
        { tool: 'Bash', id: 1, command: 'a' },
        { tool: 'Bash', id: 2, command: 'b' },
        { result: 'Bash', id: 2, is_error: true, text: 'Exit code 1\nb' },
        { result: 'Bash', id: 1, is_error: true, text: 'Exit code 1\na' },
      ]);
    });

    it('still writes a later block of a message after skipping earlier ones', async () => {
      await handleMessage(assistantToolUse('toolu_r', 'Read', { file_path: '/tmp/x' }), state);
      await handleMessage(assistantToolUse('toolu_b', 'Bash', { command: 'b' }), state);
      await handleMessage(
        toolResultMessage([
          { type: 'text', text: 'note' },
          { type: 'tool_result', tool_use_id: 'toolu_unknown', is_error: true, content: 'x' },
          { type: 'tool_result', tool_use_id: 'toolu_r', content: '1\talpha' },
          { type: 'tool_result', tool_use_id: 'toolu_b', is_error: true, content: 'Exit code 1' },
        ]),
        state,
      );

      expect(conversation()).toEqual([
        { tool: 'Read', id: 1, path: '/tmp/x' },
        { tool: 'Bash', id: 2, command: 'b' },
        { result: 'Bash', id: 2, is_error: true, text: 'Exit code 1' },
      ]);
    });

    it('skips a successful Read result, whose block has no is_error key', async () => {
      await handleMessage(assistantToolUse('toolu_r', 'Read', { file_path: '/tmp/x' }), state);
      await handleMessage(
        toolResultMessage([{ type: 'tool_result', tool_use_id: 'toolu_r', content: '1\talpha' }]),
        state,
      );

      expect(conversation()).toEqual([{ tool: 'Read', id: 1, path: '/tmp/x' }]);
    });

    it('writes a successful Bash result', async () => {
      await handleMessage(assistantToolUse('toolu_s', 'Bash', { command: 'echo ok' }), state);
      await handleMessage(
        toolResultMessage(
          [{ type: 'tool_result', tool_use_id: 'toolu_s', is_error: false, content: 'ok' }],
          {
            tool_use_result: {
              stdout: 'ok',
              stderr: '',
              interrupted: false,
              isImage: false,
              noOutputExpected: false,
            },
          },
        ),
        state,
      );

      expect(conversation()[1]).toEqual({
        result: 'Bash',
        id: 1,
        is_error: false,
        text: 'ok',
      });
    });

    it('renders array content as its text blocks joined by newlines, other blocks by type', async () => {
      await handleMessage(assistantToolUse('toolu_i', 'Read', { file_path: '/tmp/p.png' }), state);
      await handleMessage(
        toolResultMessage([
          {
            type: 'tool_result',
            tool_use_id: 'toolu_i',
            is_error: true,
            content: [
              { type: 'text', text: 'a' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
              { type: 'text', text: 'b' },
            ],
          },
        ]),
        state,
      );

      expect(conversation()[1]).toEqual({
        result: 'Read',
        id: 1,
        is_error: true,
        text: 'a\n[image]\nb',
      });
    });

    it('writes no text for a result block without content', async () => {
      await handleMessage(assistantToolUse('toolu_e', 'Bash', { command: 'true' }), state);
      await handleMessage(
        toolResultMessage([{ type: 'tool_result', tool_use_id: 'toolu_e', is_error: false }]),
        state,
      );

      expect(conversation()[1]).toEqual({ result: 'Bash', id: 1, is_error: false });
    });

    it('lists AskUserQuestion questions from the structured result, as a hook left them', async () => {
      await handleMessage(
        assistantToolUse('toolu_q', 'AskUserQuestion', {
          questions: [
            {
              question: 'Original?',
              header: 'H',
              options: [{ label: 'Red' }, { label: 'Blue' }],
              multiSelect: false,
            },
          ],
        }),
        state,
      );
      const answered = 'Your questions have been answered: "Rewritten?"="Blue".';
      await handleMessage(
        toolResultMessage([{ type: 'tool_result', tool_use_id: 'toolu_q', content: answered }], {
          tool_use_result: {
            questions: [
              {
                question: 'Rewritten?',
                header: 'H',
                options: [
                  { label: 'Red', description: 'warm' },
                  { label: 'Blue', description: 'cool' },
                ],
                multiSelect: false,
              },
            ],
            answers: { 'Rewritten?': 'Blue' },
          },
        }),
        state,
      );

      expect(conversation()[1]).toEqual({
        result: 'AskUserQuestion',
        id: 1,
        is_error: false,
        questions: [{ question: 'Rewritten?', options: ['Red', 'Blue'] }],
        text: answered,
      });
    });

    it('lists questions only on AskUserQuestion results', async () => {
      await handleMessage(assistantToolUse('toolu_b', 'Bash', { command: 'b' }), state);
      await handleMessage(
        toolResultMessage(
          [{ type: 'tool_result', tool_use_id: 'toolu_b', is_error: true, content: 'Exit code 1' }],
          { tool_use_result: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] } },
        ),
        state,
      );

      expect(conversation()[1]).toEqual({
        result: 'Bash',
        id: 1,
        is_error: true,
        text: 'Exit code 1',
      });
    });

    it('writes an AskUserQuestion result without questions when the structured result is missing or a string', async () => {
      await handleMessage(
        assistantToolUse('toolu_q1', 'AskUserQuestion', { questions: [] }),
        state,
      );
      await handleMessage(
        assistantToolUse('toolu_q2', 'AskUserQuestion', { questions: [] }),
        state,
      );
      await handleMessage(
        toolResultMessage([{ type: 'tool_result', tool_use_id: 'toolu_q1', content: 'answered' }]),
        state,
      );
      await handleMessage(
        toolResultMessage(
          [{ type: 'tool_result', tool_use_id: 'toolu_q2', is_error: true, content: 'denied' }],
          { tool_use_result: 'Error: denied' },
        ),
        state,
      );

      expect(conversation().slice(2)).toEqual([
        { result: 'AskUserQuestion', id: 1, is_error: false, text: 'answered' },
        { result: 'AskUserQuestion', id: 2, is_error: true, text: 'denied' },
      ]);
    });

    it('skips a tool_result whose call has no tool entry', async () => {
      await handleMessage(
        toolResultMessage([
          { type: 'tool_result', tool_use_id: 'toolu_unknown', is_error: true, content: 'x' },
        ]),
        state,
      );

      expect(conversation()).toEqual([]);
    });

    it('ignores replayed user messages and user text content', async () => {
      await handleMessage(assistantToolUse('toolu_p', 'Bash', { command: 'false' }), state);
      const failed = { type: 'tool_result', tool_use_id: 'toolu_p', is_error: true, content: 'x' };
      await handleMessage(toolResultMessage([failed], { isReplay: true }), state);
      await handleMessage(toolResultMessage('a prompt echoed as a string'), state);
      await handleMessage(toolResultMessage([{ type: 'text', text: 'a text block' }]), state);

      expect(conversation()).toEqual([{ tool: 'Bash', id: 1, command: 'false' }]);
    });

    it("records a subagent call's error result like a main-thread one", async () => {
      const fromSubagent = { parent_tool_use_id: 'toolu_agent' };
      await handleMessage(
        assistantToolUse('toolu_sub', 'Read', { file_path: '/tmp/missing' }, fromSubagent),
        state,
      );
      await handleMessage(
        toolResultMessage(
          [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_sub',
              is_error: true,
              content: 'File does not exist.',
            },
          ],
          fromSubagent,
        ),
        state,
      );

      expect(conversation()[1]).toEqual({
        result: 'Read',
        id: 1,
        is_error: true,
        text: 'File does not exist.',
      });
    });
  });

  describe('after the session has ended', () => {
    let decideTurnPolicy: ReturnType<typeof vi.fn>;

    function result(subtype: string, totalCostUsd: number): SDKMessage {
      return sdkMessage({ type: 'result', subtype, num_turns: 1, total_cost_usd: totalCostUsd });
    }

    beforeEach(async () => {
      decideTurnPolicy = vi
        .fn()
        .mockResolvedValueOnce({ decision: 'end', reasoning: 'done' })
        .mockResolvedValue({ decision: 'continue', message: 'one more thing', reasoning: 'r' });
      const config = parseSessionConfig({ prompt: 'p', user: { max_turns: 5 } });
      state = newSessionState({
        config,
        configPaths: ['/tmp/session.yaml'],
        projectDir: '/tmp/project',
        sandboxHome: undefined,
        claudeDir: undefined,
        oracle: { decideTurnPolicy } as unknown as Oracle,
      });
      state.sessionId = 's';
      state.syntheticUser = new SyntheticUser(state.oracle, config.user, config.prompt);

      await handleMessage(result('success', 0.01), state);
      output = '';
    });

    it('neither consults the oracle nor records what the agent does next', async () => {
      await handleMessage(
        sdkMessage({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'The task finished.' }] },
          parent_tool_use_id: null,
        }),
        state,
      );
      await handleMessage(assistantToolUse('toolu_late', 'Bash', { command: 'ls' }), state);
      await handleMessage(
        sdkMessage({
          type: 'system',
          subtype: 'hook_response',
          hook_id: 'id-stop',
          hook_name: 'Stop',
          hook_event: 'Stop',
          output: 'x',
          stdout: 'x',
          stderr: '',
          exit_code: 0,
          outcome: 'success',
        }),
        state,
      );
      await handleMessage(result('success', 0.02), state);

      expect(decideTurnPolicy).toHaveBeenCalledTimes(1);
      expect(output).toBe('');
    });

    it('raises the agent cost to a later running total but never lowers it', async () => {
      await handleMessage(result('success', 0.03), state);
      await handleMessage(result('error_during_execution', 0), state);

      expect(state.resultTotalCostUsd).toBe(0.03);
    });

    it('keeps the exit code of the decision that ended it', async () => {
      await handleMessage(result('error_max_turns', 0.02), state);

      expect(state.exitCode).toBe(EXIT_SUCCESS);
    });
  });
});
