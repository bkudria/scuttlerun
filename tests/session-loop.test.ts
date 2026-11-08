import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { handleMessage, newSessionState, type SessionState } from '../src/session-loop.js';
import { parseSessionConfig } from '../src/config.js';
import type { Oracle } from '../src/oracle.js';

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
});
