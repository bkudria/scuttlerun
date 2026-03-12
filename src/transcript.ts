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
}

function write(text: string): void {
  process.stdout.write(text);
}

function blockLines(text: string, indent: number): string {
  const pad = " ".repeat(indent);
  return text
    .trimEnd()
    .split("\n")
    .map((line) => (line.length > 0 ? `${pad}${line}` : ""))
    .join("\n") + "\n";
}

function singleQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

export function writeHeader(opts: HeaderOptions): void {
  write(`session: ${opts.session}\n`);
  if (opts.configPaths.length === 1) {
    write(`config: ${opts.configPaths[0]}\n`);
  } else {
    write(`config:\n`);
    for (const p of opts.configPaths) {
      write(`  - ${p}\n`);
    }
  }
  write(`project: ${opts.projectDir}\n`);
  write(`transcript: ${opts.transcriptPath}\n`);
  write(`\nconversation:\n`);
}

export function writeUser(text: string): void {
  write(`  - user: |\n`);
  write(blockLines(text, 6));
  write("\n");
}

export function writeThinking(text: string): void {
  write(`  - thinking: |\n`);
  write(blockLines(text, 6));
  write("\n");
}

export function writeAssistant(text: string): void {
  write(`  - assistant: |\n`);
  write(blockLines(text, 6));
  write("\n");
}

export function writeTool(name: string, input: unknown): void {
  write(`  - tool: ${name}\n`);
  const inp = input as Record<string, unknown>;

  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      write(`    path: ${inp.file_path ?? ""}\n`);
      break;
    case "Bash":
      write(`    command: |\n`);
      write(blockLines(String(inp.command ?? ""), 6));
      break;
    case "Glob":
    case "Grep":
      write(`    pattern: ${singleQuote(String(inp.pattern ?? ""))}\n`);
      break;
    default:
      write(`    input: |\n`);
      write(blockLines(JSON.stringify(inp, null, 2), 6));
      break;
  }
  write("\n");
}

export function writeOracleAsk(
  answers: Record<string, string>,
  reasoning: string,
): void {
  write(`  - oracle: ask_user\n`);
  write(`    answers:\n`);
  for (const [q, a] of Object.entries(answers)) {
    write(`      "${q}": ${a}\n`);
  }
  write(`    reasoning: ${reasoning}\n`);
  write("\n");
}

export function writeOracleTurn(
  decision: string,
  message?: string,
  reasoning?: string,
): void {
  write(`  - oracle: turn_policy\n`);
  write(`    decision: ${decision}\n`);
  if (message) {
    write(`    message: |\n`);
    write(blockLines(message, 6));
  }
  if (reasoning) {
    write(`    reasoning: ${reasoning}\n`);
  }
  write("\n");
}

export function writeFooter(stats: FooterStats): void {
  write(`\nturns: ${stats.turns}\n`);
  write(`tool_calls: ${stats.toolCalls}\n`);
  const durationSec = +(stats.durationMs / 1000).toFixed(1);
  write(`duration_s: ${durationSec}\n`);
  if (stats.totalCostUsd > 0) {
    write(`cost_usd: ${stats.totalCostUsd.toFixed(2)}\n`);
  }
}
