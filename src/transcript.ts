export interface SessionStats {
  configPaths: string[];
  projectDir: string;
  sdkSessionPath: string;
  turns: number;
  toolCalls: number;
  durationMs: number;
  totalCostUsd: number;
}

const DIVIDER = "─".repeat(39);

function write(text: string): void {
  process.stdout.write(text);
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? "    " + line : ""))
    .join("\n");
}

function writeConfigPaths(configPaths: string[]): void {
  if (configPaths.length === 0) return;
  write(`Config:     ${configPaths[0]}\n`);
  for (const p of configPaths.slice(1)) {
    write(`            ${p}\n`);
  }
}

export function printPreamble(configPaths: string[], projectDir: string): void {
  write(`─── Warren Session ${DIVIDER.slice(19)}\n`);
  writeConfigPaths(configPaths);
  write(`Project:    ${projectDir}\n`);
}

export function printTranscriptPath(sdkSessionPath: string): void {
  write(`Transcript: ${sdkSessionPath}\n`);
  write(`${DIVIDER}\n`);
}

export function printSessionStarted(sessionId: string): void {
  write(`\n[warren] Session started: ${sessionId}\n`);
}

export function printUserMessage(text: string): void {
  write(`\n[User]\n${indent(text.trimEnd())}\n`);
}

export function printThinking(text: string): void {
  write(`\n[Thinking]\n${indent(text.trimEnd())}\n`);
}

export function printAssistantText(text: string): void {
  write(`\n[Assistant]\n${indent(text.trimEnd())}\n`);
}

export function printToolUse(name: string, input: unknown): void {
  write(`\n[Tool]\n${indent(formatToolUse(name, input))}\n`);
}

function formatToolUse(name: string, input: unknown): string {
  const inp = input as Record<string, unknown>;

  switch (name) {
    case "Read":
      return `⚙ Read ${inp.file_path ?? ""}`;
    case "Write":
      return `⚙ Write ${inp.file_path ?? ""}`;
    case "Edit":
      return `⚙ Edit ${inp.file_path ?? ""}`;
    case "Bash": {
      const cmd = String(inp.command ?? "");
      return `⚙ Bash: ${cmd.length > 100 ? cmd.slice(0, 100) + "…" : cmd}`;
    }
    case "Glob":
      return `⚙ Glob ${inp.pattern ?? ""}`;
    case "Grep":
      return `⚙ Grep "${inp.pattern ?? ""}"`;
    default:
      return `⚙ ${name}`;
  }
}

export function printOracleAskUser(
  answers: Record<string, string>,
  reasoning: string,
): void {
  const parts = Object.entries(answers)
    .map(([q, a]) => `${q} → ${a}`)
    .join("; ");
  write(`    ⚡ Oracle answered: ${parts}\n`);
  write(`      Reasoning: ${reasoning}\n`);
}

export function printOracleTurnPolicy(
  decision: string,
  message?: string,
  reasoning?: string,
): void {
  write(`    ⚡ Oracle: ${decision}`);
  if (message) {
    write(` — "${message}"`);
  }
  write("\n");
  if (reasoning) {
    write(`      Reasoning: ${reasoning}\n`);
  }
}

export function printSummary(stats: SessionStats): void {
  write(`\n─── Summary ${DIVIDER.slice(12)}\n`);
  writeConfigPaths(stats.configPaths);
  write(`Project:    ${stats.projectDir}\n`);
  write(`Transcript: ${stats.sdkSessionPath}\n`);
  write(`Turns:      ${stats.turns}\n`);
  write(`Tool calls: ${stats.toolCalls}\n`);
  const durationSec = (stats.durationMs / 1000).toFixed(1);
  write(`Duration:   ${durationSec}s\n`);
  if (stats.totalCostUsd > 0) {
    write(`Cost:       $${stats.totalCostUsd.toFixed(2)}\n`);
  }
  write(`${DIVIDER}\n`);
}
