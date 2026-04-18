import { Document, Scalar, visit } from "yaml";

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
  oracleCostUsd?: number;
  timedOut?: boolean;
  filesWritten?: string[];
  filesEdited?: string[];
  filesRead?: string[];
  oracleUsage?: { input_tokens: number; output_tokens: number; calls: number; cost_usd?: number };
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
  visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value === "string" && node.value.includes("\n")) {
        node.type = Scalar.BLOCK_LITERAL;
      }
    },
  });
  const raw = doc.toString({ lineWidth: 0 });
  const lines = raw.replace(/\n$/, "").split("\n");
  const indented = lines
    .map((line, i) => {
      if (i === 0) return `  - ${line}`;
      if (line === "") return "";
      return `    ${line}`;
    })
    .join("\n");
  write(indented + "\n\n");
}

export function writeHeader(opts: HeaderOptions): void {
  const header: Record<string, unknown> = {
    session: opts.session,
    config:
      opts.configPaths.length === 1
        ? opts.configPaths[0]
        : opts.configPaths,
    project: opts.projectDir,
    transcript: opts.transcriptPath,
  };
  const doc = new Document(header);
  doc.directives!.docStart = true;
  write(doc.toString({ lineWidth: 0 }));
  write("\nconversation:\n");
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

export function writeTool(name: string, input: unknown): void {
  const inp = input as Record<string, unknown>;
  const entry: Record<string, unknown> = { tool: name };

  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      entry.path = String(inp.file_path ?? "");
      break;
    case "Bash":
      entry.command = String(inp.command ?? "");
      break;
    case "Glob":
    case "Grep":
      entry.pattern = String(inp.pattern ?? "");
      break;
    default:
      entry.input = inp;
      break;
  }

  writeEntry(entry);
}

export function writeOracleAsk(
  answers: Record<string, string>,
  reasoning: string,
): void {
  writeEntry({ oracle: "ask_user", answers, reasoning });
}

export function writeOracleTurn(
  decision: string,
  message?: string,
  reasoning?: string,
): void {
  const entry: Record<string, unknown> = { oracle: "turn", decision };
  if (message) entry.message = message;
  if (reasoning) entry.reasoning = reasoning;
  writeEntry(entry);
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
    footer.oracle_usage = stats.oracleUsage;
  }
  const doc = new Document(footer);
  write("\n" + doc.toString({ lineWidth: 0 }));
}
