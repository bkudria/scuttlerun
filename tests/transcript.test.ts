import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  writeHeader,
  writeUser,
  writeThinking,
  writeAssistant,
  writeTool,
  writeOracleAsk,
  writeOracleTurn,
  writeOracleError,
  writeFooter,
} from '../src/transcript.js';

describe('transcript', () => {
  let output: string;
  const originalWrite = process.stdout.write;

  beforeEach(() => {
    output = '';
    process.stdout.write = ((chunk: string) => {
      output += chunk;
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  describe('writeHeader', () => {
    it('writes session, config, project, transcript and conversation header', () => {
      writeHeader({
        session: 'abc-123',
        configPaths: ['/path/to/session.yaml'],
        projectDir: '/tmp/scuttlerun-project-abc123',
        transcriptPath: '/home/user/.claude/projects/-tmp-foo/abc123.jsonl',
      });
      const parsed = parseYaml(output + '  - user: |\n      placeholder\n');
      expect(parsed.session).toBe('abc-123');
      expect(parsed.config).toBe('/path/to/session.yaml');
      expect(parsed.project).toBe('/tmp/scuttlerun-project-abc123');
      expect(parsed.transcript).toBe('/home/user/.claude/projects/-tmp-foo/abc123.jsonl');
      expect(output).toContain('conversation:\n');
    });

    it('starts with YAML document start marker', () => {
      writeHeader({
        session: 'abc-123',
        configPaths: ['/path/to/session.yaml'],
        projectDir: '/tmp/proj',
        transcriptPath: '/tmp/transcript.jsonl',
      });
      expect(output).toMatch(/^---\n/);
    });

    it('writes config as list for multiple paths', () => {
      writeHeader({
        session: 'abc-123',
        configPaths: ['/path/to/base.yaml', '/path/to/override.yaml'],
        projectDir: '/tmp/scuttlerun-project-abc123',
        transcriptPath: '/home/user/.claude/projects/-tmp-foo/abc123.jsonl',
      });
      const parsed = parseYaml(output + '  - user: |\n      placeholder\n');
      expect(parsed.config).toEqual(['/path/to/base.yaml', '/path/to/override.yaml']);
    });
  });

  describe('writeUser', () => {
    it('writes user entry as block scalar', () => {
      writeUser('Write a haiku about the ocean');
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].user).toBe('Write a haiku about the ocean');
    });

    it('preserves multi-line content', () => {
      writeUser('Line one\nLine two');
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].user).toBe('Line one\nLine two');
    });
  });

  describe('writeThinking', () => {
    it('writes thinking entry as block scalar', () => {
      writeThinking('I should write a 5-7-5 haiku.');
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].thinking).toBe('I should write a 5-7-5 haiku.');
    });
  });

  describe('writeAssistant', () => {
    it('writes assistant entry as block scalar', () => {
      writeAssistant('Here is a haiku.');
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].assistant).toBe('Here is a haiku.');
    });

    it('preserves multi-line content with markdown', () => {
      writeAssistant('Here it is:\n\n> *Waves crash*\n> *Salt wind*');
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].assistant).toContain('> *Waves crash*');
      expect(parsed.conversation[0].assistant).toContain('> *Salt wind*');
    });
  });

  describe('writeTool', () => {
    it('writes Read with path', () => {
      writeTool('Read', { file_path: '/tmp/foo.txt' });
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].tool).toBe('Read');
      expect(parsed.conversation[0].path).toBe('/tmp/foo.txt');
    });

    it('writes Write with path', () => {
      writeTool('Write', { file_path: '/tmp/foo.txt' });
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].tool).toBe('Write');
      expect(parsed.conversation[0].path).toBe('/tmp/foo.txt');
    });

    it('writes Edit with path', () => {
      writeTool('Edit', { file_path: '/tmp/bar.ts' });
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].tool).toBe('Edit');
      expect(parsed.conversation[0].path).toBe('/tmp/bar.ts');
    });

    it('writes Bash with command as block scalar', () => {
      writeTool('Bash', { command: 'echo hello && pwd' });
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].tool).toBe('Bash');
      expect(parsed.conversation[0].command).toBe('echo hello && pwd');
    });

    it('writes Glob with single-quoted pattern', () => {
      writeTool('Glob', { pattern: '**/*.ts' });
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].tool).toBe('Glob');
      expect(parsed.conversation[0].pattern).toBe('**/*.ts');
    });

    it('writes Grep with single-quoted pattern', () => {
      writeTool('Grep', { pattern: 'function\\s+\\w+' });
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].tool).toBe('Grep');
      expect(parsed.conversation[0].pattern).toBe('function\\s+\\w+');
    });

    it('writes TodoWrite with todos array as top-level field', () => {
      writeTool('TodoWrite', {
        todos: [
          { content: 'Fix math.py', status: 'in_progress', activeForm: 'Fixing math.py' },
          { content: 'Fix util.py', status: 'pending', activeForm: 'Fixing util.py' },
        ],
      });
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].tool).toBe('TodoWrite');
      expect(parsed.conversation[0].todos).toHaveLength(2);
      expect(parsed.conversation[0].todos[0].content).toBe('Fix math.py');
      expect(parsed.conversation[0].todos[0].status).toBe('in_progress');
      expect(parsed.conversation[0].input).toBeUndefined();
    });

    it('handles missing todos in TodoWrite gracefully', () => {
      writeTool('TodoWrite', {});
      expect(output).toContain('todos:');
    });

    it('writes TaskCreate with subject and description', () => {
      writeTool('TaskCreate', {
        subject: 'Fix math.py',
        description: 'Replace the broken add() with the correct implementation',
      });
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].tool).toBe('TaskCreate');
      expect(parsed.conversation[0].subject).toBe('Fix math.py');
      expect(parsed.conversation[0].description).toBe(
        'Replace the broken add() with the correct implementation',
      );
      expect(parsed.conversation[0].input).toBeUndefined();
    });

    it('handles missing TaskCreate fields gracefully', () => {
      writeTool('TaskCreate', {});
      expect(output).toContain('subject:');
      expect(output).toContain('description:');
    });

    it('writes TaskUpdate with task_id and status', () => {
      writeTool('TaskUpdate', { taskId: 'task-42', status: 'in_progress' });
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].tool).toBe('TaskUpdate');
      expect(parsed.conversation[0].task_id).toBe('task-42');
      expect(parsed.conversation[0].status).toBe('in_progress');
      expect(parsed.conversation[0].input).toBeUndefined();
    });

    it('writes TaskUpdate without status when omitted', () => {
      writeTool('TaskUpdate', { taskId: 'task-42' });
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].tool).toBe('TaskUpdate');
      expect(parsed.conversation[0].task_id).toBe('task-42');
      expect(parsed.conversation[0].status).toBeUndefined();
    });

    it('writes TaskList with no extra fields', () => {
      writeTool('TaskList', {});
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].tool).toBe('TaskList');
      expect(parsed.conversation[0].input).toBeUndefined();
      expect(parsed.conversation[0].task_id).toBeUndefined();
    });

    it('writes TaskGet with task_id', () => {
      writeTool('TaskGet', { taskId: 'task-42' });
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].tool).toBe('TaskGet');
      expect(parsed.conversation[0].task_id).toBe('task-42');
      expect(parsed.conversation[0].input).toBeUndefined();
    });

    it('writes unknown tools with input as YAML mapping', () => {
      writeTool('Agent', { prompt: 'do something' });
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].tool).toBe('Agent');
      expect(parsed.conversation[0].input.prompt).toBe('do something');
    });

    it('handles missing file_path in Read/Write/Edit', () => {
      writeTool('Read', {});
      expect(output).toContain('path:');
    });

    it('handles missing taskId in TaskUpdate', () => {
      writeTool('TaskUpdate', {});
      expect(output).toContain('task_id:');
    });

    it('handles missing taskId in TaskGet', () => {
      writeTool('TaskGet', {});
      expect(output).toContain('task_id:');
    });

    it('handles missing command in Bash', () => {
      writeTool('Bash', {});
      expect(output).toContain('command:');
    });

    it('handles missing pattern in Glob', () => {
      writeTool('Glob', {});
      expect(output).toContain('pattern:');
    });
  });

  describe('writeOracleAsk', () => {
    it('writes oracle ask_user entry with answers and reasoning', () => {
      writeOracleAsk({ 'What language?': 'Python' }, 'User prefers Python');
      const parsed = parseYaml('conversation:\n' + output);
      const entry = parsed.conversation[0];
      expect(entry.oracle).toBe('ask_user');
      expect(entry.answers['What language?']).toBe('Python');
      expect(entry.reasoning).toBe('User prefers Python');
    });

    it('handles multiline question keys', () => {
      writeOracleAsk(
        { 'Which option do you prefer?\nOption A or Option B': 'Option A' },
        'Clear preference',
      );
      const parsed = parseYaml('conversation:\n' + output);
      const entry = parsed.conversation[0];
      expect(entry.oracle).toBe('ask_user');
      const key = Object.keys(entry.answers)[0];
      expect(key).toContain('Which option do you prefer?');
      expect(key).toContain('Option A or Option B');
      expect(Object.values(entry.answers)[0]).toBe('Option A');
    });

    it('handles multiline answer values as block scalars', () => {
      writeOracleAsk(
        { 'What should I do?': 'First do X.\nThen do Y.\nFinally do Z.' },
        'Step by step',
      );
      const parsed = parseYaml('conversation:\n' + output);
      const entry = parsed.conversation[0];
      expect(entry.answers['What should I do?']).toContain('First do X.');
      expect(entry.answers['What should I do?']).toContain('Then do Y.');
      expect(entry.answers['What should I do?']).toContain('Finally do Z.');
    });

    it('handles YAML-special characters in question keys', () => {
      writeOracleAsk({ 'Use {braces}: yes or #no?': 'yes' }, 'Confirmed');
      const parsed = parseYaml('conversation:\n' + output);
      const entry = parsed.conversation[0];
      expect(entry.answers['Use {braces}: yes or #no?']).toBe('yes');
    });

    it('handles multiline reasoning as block scalar', () => {
      writeOracleAsk(
        { 'Language?': 'Python' },
        'The user mentioned Python earlier.\nThey also have a .py file in the project.',
      );
      const parsed = parseYaml('conversation:\n' + output);
      const entry = parsed.conversation[0];
      expect(entry.reasoning).toContain('The user mentioned Python earlier.');
      expect(entry.reasoning).toContain('They also have a .py file in the project.');
    });

    it('wraps long reasoning to fit 80 cols', () => {
      writeOracleAsk(
        { 'Language?': 'Python' },
        'As a Python enthusiast who prefers simple, readable code, Python is the natural choice. It aligns perfectly with the stated preference for simplicity.',
      );
      const longest = Math.max(...output.split('\n').map((l) => l.length));
      expect(longest).toBeLessThanOrEqual(80);
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].reasoning).toContain('Python is the natural choice');
    });
  });

  describe('writeOracleTurn', () => {
    it('writes continue decision with message and reasoning', () => {
      writeOracleTurn('continue', 'Can you add tests?', 'Task incomplete');
      const parsed = parseYaml('conversation:\n' + output);
      const entry = parsed.conversation[0];
      expect(entry.oracle).toBe('turn');
      expect(entry.decision).toBe('continue');
      expect(entry.message).toContain('Can you add tests?');
      expect(entry.reasoning).toBe('Task incomplete');
    });

    it('handles multiline reasoning as block scalar', () => {
      writeOracleTurn('continue', 'Add tests', 'Task is incomplete.\nTests are missing.');
      const parsed = parseYaml('conversation:\n' + output);
      const entry = parsed.conversation[0];
      expect(entry.reasoning).toContain('Task is incomplete.');
      expect(entry.reasoning).toContain('Tests are missing.');
    });

    it('writes end decision without message', () => {
      writeOracleTurn('end', undefined, 'Task complete');
      const parsed = parseYaml('conversation:\n' + output);
      const entry = parsed.conversation[0];
      expect(entry.oracle).toBe('turn');
      expect(entry.decision).toBe('end');
      expect(entry.message).toBeUndefined();
      expect(entry.reasoning).toBe('Task complete');
    });

    it('writes decision without reasoning', () => {
      writeOracleTurn('end');
      const parsed = parseYaml('conversation:\n' + output);
      const entry = parsed.conversation[0];
      expect(entry.oracle).toBe('turn');
      expect(entry.decision).toBe('end');
      expect(entry.reasoning).toBeUndefined();
    });
  });

  describe('writeOracleError', () => {
    it('writes oracle: error with reason', () => {
      writeOracleError('Oracle exhausted 4 attempts: network down');
      const parsed = parseYaml('conversation:\n' + output);
      const entry = parsed.conversation[0];
      expect(entry.oracle).toBe('error');
      expect(entry.reason).toBe('Oracle exhausted 4 attempts: network down');
    });

    it('handles multiline reason as block scalar', () => {
      writeOracleError('First line.\nSecond line.\nThird line.');
      const parsed = parseYaml('conversation:\n' + output);
      const entry = parsed.conversation[0];
      expect(entry.reason).toContain('First line.');
      expect(entry.reason).toContain('Third line.');
    });
  });

  describe('writeFooter', () => {
    it('writes stats as top-level YAML keys', () => {
      writeFooter({
        turns: 5,
        toolCalls: 3,
        durationMs: 12345,
        totalCostUsd: 0.05,
      });
      const parsed = parseYaml(output);
      expect(parsed.turns).toBe(5);
      expect(parsed.tool_calls).toBe(3);
      expect(parsed.duration_s).toBe(12.3);
      expect(parsed.cost_usd).toBe(0.05);
    });

    it('omits cost_usd when zero', () => {
      writeFooter({
        turns: 1,
        toolCalls: 0,
        durationMs: 5000,
        totalCostUsd: 0,
      });
      expect(output).not.toContain('cost_usd');
    });

    it('emits cost_incomplete when the agent cost is incomplete', () => {
      writeFooter({
        turns: 0,
        toolCalls: 0,
        durationMs: 5000,
        totalCostUsd: 0,
        costIncomplete: true,
      });
      const parsed = parseYaml(output);
      expect(parsed.cost_incomplete).toBe(true);
    });

    it('omits cost_incomplete when the agent cost is complete', () => {
      writeFooter({
        turns: 1,
        toolCalls: 0,
        durationMs: 5000,
        totalCostUsd: 0.05,
      });
      expect(output).not.toContain('cost_incomplete');
    });

    it('writes file lists when provided', () => {
      writeFooter({
        turns: 1,
        toolCalls: 3,
        durationMs: 5000,
        totalCostUsd: 0.01,
        filesWritten: ['/tmp/foo.txt'],
        filesEdited: ['/tmp/bar.ts'],
        filesRead: ['/tmp/baz.md', '/tmp/qux.ts'],
      });
      const parsed = parseYaml(output);
      expect(parsed.files_written).toEqual(['/tmp/foo.txt']);
      expect(parsed.files_edited).toEqual(['/tmp/bar.ts']);
      expect(parsed.files_read).toEqual(['/tmp/baz.md', '/tmp/qux.ts']);
    });

    it('omits file lists when empty', () => {
      writeFooter({
        turns: 1,
        toolCalls: 0,
        durationMs: 5000,
        totalCostUsd: 0,
        filesWritten: [],
        filesEdited: [],
        filesRead: [],
      });
      expect(output).not.toContain('files_written');
      expect(output).not.toContain('files_edited');
      expect(output).not.toContain('files_read');
    });

    it('omits file lists when not provided', () => {
      writeFooter({
        turns: 1,
        toolCalls: 0,
        durationMs: 5000,
        totalCostUsd: 0,
      });
      expect(output).not.toContain('files_written');
      expect(output).not.toContain('files_edited');
      expect(output).not.toContain('files_read');
    });

    it('includes oracle_usage when provided', () => {
      writeFooter({
        turns: 3,
        toolCalls: 5,
        durationMs: 12000,
        totalCostUsd: 0.05,
        oracleUsage: {
          input_tokens: 1500,
          output_tokens: 200,
          calls: 4,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      });
      expect(output).toContain('oracle_usage:');
      expect(output).toContain('input_tokens: 1500');
      expect(output).toContain('output_tokens: 200');
      expect(output).toContain('calls: 4');
    });

    it('includes cache_creation_input_tokens and cache_read_input_tokens in oracle_usage', () => {
      writeFooter({
        turns: 3,
        toolCalls: 5,
        durationMs: 12000,
        totalCostUsd: 0.05,
        oracleUsage: {
          input_tokens: 1500,
          output_tokens: 200,
          calls: 4,
          cache_creation_input_tokens: 250,
          cache_read_input_tokens: 2000,
        },
      });
      const parsed = parseYaml(output);
      expect(parsed.oracle_usage).toBeDefined();
      expect(parsed.oracle_usage.input_tokens).toBe(1500);
      expect(parsed.oracle_usage.output_tokens).toBe(200);
      expect(parsed.oracle_usage.cache_creation_input_tokens).toBe(250);
      expect(parsed.oracle_usage.cache_read_input_tokens).toBe(2000);
      expect(parsed.oracle_usage.calls).toBe(4);
    });

    it('includes cache token fields in oracle_usage even when zero', () => {
      writeFooter({
        turns: 3,
        toolCalls: 5,
        durationMs: 12000,
        totalCostUsd: 0.05,
        oracleUsage: {
          input_tokens: 1500,
          output_tokens: 200,
          calls: 4,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      });
      const parsed = parseYaml(output);
      expect(parsed.oracle_usage.cache_creation_input_tokens).toBe(0);
      expect(parsed.oracle_usage.cache_read_input_tokens).toBe(0);
    });

    it('omits oracle_usage when calls is 0', () => {
      writeFooter({
        turns: 1,
        toolCalls: 0,
        durationMs: 5000,
        totalCostUsd: 0,
        oracleUsage: {
          input_tokens: 0,
          output_tokens: 0,
          calls: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      });
      expect(output).not.toContain('oracle_usage');
    });

    it('emits timed_out: true when the session timed out', () => {
      writeFooter({
        turns: 1,
        toolCalls: 0,
        durationMs: 300_000,
        totalCostUsd: 0,
        timedOut: true,
      });
      expect(output).toContain('timed_out: true');
    });

    it('omits timed_out when not timed out', () => {
      writeFooter({
        turns: 1,
        toolCalls: 0,
        durationMs: 5000,
        totalCostUsd: 0,
      });
      expect(output).not.toContain('timed_out');
    });
  });

  describe('line wrapping', () => {
    it('renders long single-line strings as block-folded (`>`)', () => {
      const text = 'a long single-line string '.repeat(8).trim();
      writeAssistant(text);
      expect(output).toMatch(/assistant: >-?\n/);
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].assistant).toBe(text);
    });

    it('keeps short single-line strings as plain scalars', () => {
      writeAssistant('Hi');
      expect(output).not.toMatch(/assistant: >-?\n/);
      expect(output).toContain('assistant: Hi');
    });

    it('wraps final output to fit 80 cols (block-folded single-line strings)', () => {
      const text = 'x '.repeat(80).trim();
      writeAssistant(text);
      const longest = Math.max(...output.split('\n').map((l) => l.length));
      expect(longest).toBeLessThanOrEqual(80);
    });

    it('hard-wraps long lines inside multi-line strings before block-literal serialization', () => {
      const longInternal =
        'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega extra padding words here';
      writeUser(`First line\n${longInternal}\nLast line`);
      const longest = Math.max(...output.split('\n').map((l) => l.length));
      expect(longest).toBeLessThanOrEqual(80);
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].user).toContain('First line');
      expect(parsed.conversation[0].user).toContain('Last line');
      for (const line of parsed.conversation[0].user.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(72);
      }
    });

    it('leaves unbreakable strings (no whitespace) unwrapped', () => {
      const blob = 'a'.repeat(200);
      writeTool('Bash', { command: blob });
      const parsed = parseYaml('conversation:\n' + output);
      expect(parsed.conversation[0].command).toBe(blob);
    });
  });
});
