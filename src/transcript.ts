export interface SessionStats {
  configPaths: string[];
  projectDir: string;
  sdkSessionPath: string;
  turns: number;
  toolCalls: number;
  durationMs: number;
  totalCostUsd: number;
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  id?: string;
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

export function printPreamble(configPaths: string[], projectDir: string): void {
  write(`─── Warren Session ${DIVIDER.slice(19)}\n`);
  if (configPaths.length === 1) {
    write(`Config:     ${configPaths[0]}\n`);
  } else {
    write(`Config:     ${configPaths[0]}\n`);
    for (const p of configPaths.slice(1)) {
      write(`            ${p}\n`);
    }
  }
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

/**
 * Print a complete assistant message with all its content blocks.
 * Thinking blocks get their own [Thinking] header.
 * Text and tool_use blocks are grouped under [Assistant].
 * Returns the number of tool_use blocks encountered.
 */
export function printAssistantMessage(blocks: ContentBlock[]): number {
  let toolCallCount = 0;
  let assistantHeaderPrinted = false;
  let lastBlockType = "";

  for (const block of blocks) {
    if (block.type === "thinking" && block.thinking) {
      printThinking(block.thinking);
      lastBlockType = "thinking";
    } else if (block.type === "text" && block.text) {
      if (!assistantHeaderPrinted) {
        write("\n[Assistant]\n");
        assistantHeaderPrinted = true;
      } else if (lastBlockType === "tool_use") {
        // Blank line after tool uses before more text
        write("\n");
      }
      write(`${indent(block.text.trimEnd())}\n`);
      lastBlockType = "text";
    } else if (block.type === "tool_use" && block.name) {
      if (!assistantHeaderPrinted) {
        write("\n[Assistant]\n");
        assistantHeaderPrinted = true;
      }
      if (lastBlockType === "text") {
        // Blank line between text and tool uses
        write("\n");
      }
      write(`${indent(formatToolUse(block.name, block.input))}\n`);
      toolCallCount++;
      lastBlockType = "tool_use";
    }
  }

  return toolCallCount;
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

export function printToolResult(
  _toolUseId: string,
  result: string,
  isError: boolean,
): void {
  const icon = isError ? "✗" : "✓";
  const truncated =
    result.length > 200 ? result.slice(0, 200) + "…" : result;
  const oneLine = truncated.replace(/\n/g, " ").trim();
  write(`    ${icon} ${oneLine}\n`);
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
  if (stats.configPaths.length === 1) {
    write(`Config:     ${stats.configPaths[0]}\n`);
  } else {
    write(`Config:     ${stats.configPaths[0]}\n`);
    for (const p of stats.configPaths.slice(1)) {
      write(`            ${p}\n`);
    }
  }
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
