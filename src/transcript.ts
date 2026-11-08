import { Document, Scalar, visit } from 'yaml';
import wrap from 'word-wrap';

const LINE_WIDTH = 80;
const ENTRY_PREFIX_WIDTH = 4;
const DOC_LINE_WIDTH = LINE_WIDTH - ENTRY_PREFIX_WIDTH;
const HEADER_FOOTER_LINE_WIDTH = LINE_WIDTH;
const HARD_WRAP_WIDTH = 72;
const FOLD_THRESHOLD = 64;

function hardWrapLines(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line.length <= HARD_WRAP_WIDTH
        ? line
        : wrap(line, { width: HARD_WRAP_WIDTH, indent: '', trim: true, cut: false }),
    )
    .join('\n');
}

function applyWrapStyles(doc: Document): void {
  visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value !== 'string') return;
      if (node.value.includes('\n')) {
        node.value = hardWrapLines(node.value);
        node.type = Scalar.BLOCK_LITERAL;
      } else if (node.value.length > FOLD_THRESHOLD) {
        node.type = Scalar.BLOCK_FOLDED;
      }
    },
  });
}

export interface HeaderOptions {
  session: string;
  configPaths: string[];
  projectDir: string;
  transcriptPath: string;
}

export interface FooterStats {
  turns: number;
  toolCalls: number;
  durationMs: number;
  totalCostUsd: number;
  costIncomplete?: boolean;
  transcriptIncomplete?: boolean;
  oracleCostUsd?: number;
  timedOut?: boolean;
  filesWritten?: string[];
  filesEdited?: string[];
  filesRead?: string[];
  oracleUsage?: {
    input_tokens: number;
    output_tokens: number;
    calls: number;
    cost_usd?: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
}

function write(text: string): void {
  process.stdout.write(text);
}

/**
 * Serialize a JS object as a YAML mapping, indent it as a sequence item
 * under `conversation:`, and write it to stdout.
 */
function writeEntry(entry: Record<string, unknown>): void {
  const doc = new Document(entry);
  applyWrapStyles(doc);
  const raw = doc.toString({ lineWidth: DOC_LINE_WIDTH });
  const lines = raw.replace(/\n$/, '').split('\n');
  const indented = lines
    .map((line, i) => {
      if (i === 0) return `  - ${line}`;
      if (line === '') return '';
      return `    ${line}`;
    })
    .join('\n');
  write(indented + '\n\n');
}

export function writeHeader(opts: HeaderOptions): void {
  const header: Record<string, unknown> = {
    session: opts.session,
    config: opts.configPaths.length === 1 ? opts.configPaths[0] : opts.configPaths,
    project: opts.projectDir,
    transcript: opts.transcriptPath,
    legend: TRANSCRIPT_LEGEND,
  };
  const doc = new Document(header);
  /* v8 ignore next 3 -- yaml Document always has directives; defensive guard */
  if (!doc.directives) {
    throw new Error('Document constructed without directives');
  }
  doc.directives.docStart = true;
  applyWrapStyles(doc);
  write(doc.toString({ lineWidth: HEADER_FOOTER_LINE_WIDTH }));
  write('\nconversation:\n');
}

export function writeUser(text: string): void {
  writeEntry({ user: text });
}

export function writeThinking(text: string): void {
  writeEntry({ thinking: text });
}

export function writeAssistant(text: string): void {
  writeEntry({ assistant: text });
}

interface ToolField {
  name: string;
  from: string;
  kind: 'text' | 'list' | 'optional';
}

interface ToolFieldRule {
  tools: string[];
  fields: ToolField[];
  dropped?: string[];
}

function text(name: string, from = name): ToolField {
  return { name, from, kind: 'text' };
}

// Drives both the tool entries and the legend's description of them, so the
// two cannot disagree.
const TOOL_FIELD_RULES: ToolFieldRule[] = [
  {
    tools: ['Read', 'Write', 'Edit'],
    fields: [text('path', 'file_path')],
    dropped: ['content', 'old_string', 'new_string'],
  },
  { tools: ['Bash'], fields: [text('command')] },
  { tools: ['Glob', 'Grep'], fields: [text('pattern')] },
  { tools: ['TodoWrite'], fields: [{ name: 'todos', from: 'todos', kind: 'list' }] },
  { tools: ['TaskCreate'], fields: [text('subject'), text('description')] },
  {
    tools: ['TaskUpdate'],
    fields: [text('task_id', 'taskId'), { name: 'status', from: 'status', kind: 'optional' }],
  },
  { tools: ['TaskGet'], fields: [text('task_id', 'taskId')] },
  { tools: ['TaskList'], fields: [] },
];

const listFormat = new Intl.ListFormat('en-GB', { type: 'conjunction' });

function describeToolFields(rule: ToolFieldRule): string {
  const kept =
    rule.fields
      .map((f) => (f.kind === 'optional' ? `plus ${f.name} when given` : f.name))
      .join(', ') || 'no fields';
  return rule.dropped ? `${kept}; ${listFormat.format(rule.dropped)} are dropped` : kept;
}

const OUTPUT_CAP_CHARS = 4000;

export const TRANSCRIPT_LEGEND: Record<string, unknown> = {
  entries: {
    user: 'a synthetic-user message; the first is the scenario prompt, any leading slash command included',
    assistant: "the agent's reply text",
    thinking: "the agent's thinking text",
    tool: 'a tool call the agent requested, with only the fields under tool fields; whether it ran or failed is not shown, but hook entries after it show how any hooks responded',
    hook: `a hook that ran: its event and matcher, outcome, exit_code, and stdout and stderr when non-empty, each cut to ${OUTPUT_CAP_CHARS} characters`,
    oracle:
      "the synthetic user's decisions: ask_user (answers, reasoning), turn (decision, message, reasoning), error (reason)",
  },
  'tool fields': {
    ...Object.fromEntries(
      TOOL_FIELD_RULES.map((rule) => [rule.tools.join(', '), describeToolFields(rule)]),
    ),
    'any other tool': 'input, the full input',
  },
  'not recorded': "tool results; the session log at the header's transcript path has them",
  footer: {
    cost_incomplete: 'some spend went unreported',
    transcript_incomplete: 'the session log is missing lines',
    timed_out: 'the session hit its timeout',
  },
};

export function writeTool(name: string, input: unknown): void {
  const inp = input as Record<string, unknown>;
  const entry: Record<string, unknown> = { tool: name };
  const rule = TOOL_FIELD_RULES.find((r) => r.tools.includes(name));

  if (!rule) {
    entry.input = inp;
  } else {
    for (const field of rule.fields) {
      const value = inp[field.from];
      if (field.kind === 'list') entry[field.name] = value ?? [];
      else if (field.kind === 'text') entry[field.name] = String(value ?? '');
      else if (value !== undefined) entry[field.name] = String(value);
    }
  }

  writeEntry(entry);
}

function capOutput(text: string): string {
  if (text.length <= OUTPUT_CAP_CHARS) return text;
  const rest = text.length - OUTPUT_CAP_CHARS;
  return `${text.slice(0, OUTPUT_CAP_CHARS)}\n… [${rest} more characters; the session log has the full output]`;
}

// The fields of the SDK's hook_response message that an entry keeps.
export interface HookResponse {
  hook_name: string;
  outcome: string;
  exit_code?: number;
  stdout: string;
  stderr: string;
}

export function writeHook(hook: HookResponse): void {
  const entry: Record<string, unknown> = { hook: hook.hook_name, outcome: hook.outcome };
  if (hook.exit_code !== undefined) entry.exit_code = hook.exit_code;
  if (hook.stdout) entry.stdout = capOutput(hook.stdout);
  if (hook.stderr) entry.stderr = capOutput(hook.stderr);
  writeEntry(entry);
}

export function writeOracleAsk(answers: Record<string, string>, reasoning: string): void {
  writeEntry({ oracle: 'ask_user', answers, reasoning });
}

export function writeOracleTurn(decision: string, message?: string, reasoning?: string): void {
  const entry: Record<string, unknown> = { oracle: 'turn', decision };
  if (message) entry.message = message;
  if (reasoning) entry.reasoning = reasoning;
  writeEntry(entry);
}

export function writeOracleError(reason: string): void {
  writeEntry({ oracle: 'error', reason });
}

export function writeFooter(stats: FooterStats): void {
  const footer: Record<string, unknown> = {
    turns: stats.turns,
    tool_calls: stats.toolCalls,
    duration_s: +(stats.durationMs / 1000).toFixed(1),
  };
  if (stats.totalCostUsd > 0) {
    footer.cost_usd = +stats.totalCostUsd.toFixed(4);
  }
  if (stats.oracleCostUsd !== undefined && stats.oracleCostUsd > 0) {
    footer.oracle_cost_usd = +stats.oracleCostUsd.toFixed(4);
  }
  if (stats.costIncomplete) {
    footer.cost_incomplete = true;
  }
  if (stats.transcriptIncomplete) {
    footer.transcript_incomplete = true;
  }
  if (stats.timedOut) {
    footer.timed_out = true;
  }
  if (stats.filesWritten && stats.filesWritten.length > 0) {
    footer.files_written = stats.filesWritten;
  }
  if (stats.filesEdited && stats.filesEdited.length > 0) {
    footer.files_edited = stats.filesEdited;
  }
  if (stats.filesRead && stats.filesRead.length > 0) {
    footer.files_read = stats.filesRead;
  }
  if (stats.oracleUsage && stats.oracleUsage.calls > 0) {
    const { cost_usd } = stats.oracleUsage;
    footer.oracle_usage =
      cost_usd === undefined
        ? stats.oracleUsage
        : { ...stats.oracleUsage, cost_usd: +cost_usd.toFixed(4) };
  }
  const doc = new Document(footer);
  applyWrapStyles(doc);
  write('\n' + doc.toString({ lineWidth: HEADER_FOOTER_LINE_WIDTH }));
}
