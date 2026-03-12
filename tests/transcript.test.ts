import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  printPreamble,
  printTranscriptPath,
  printSessionStarted,
  printUserMessage,
  printThinking,
  printAssistantText,
  printToolUse,
  printOracleAskUser,
  printOracleTurnPolicy,
  printSummary,
} from "../src/transcript.js";

describe("transcript", () => {
  let output: string;
  const originalWrite = process.stdout.write;

  beforeEach(() => {
    output = "";
    process.stdout.write = ((chunk: string) => {
      output += chunk;
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  describe("printPreamble", () => {
    it("prints header with config paths and project dir", () => {
      printPreamble(["/path/to/session.yml"], "/tmp/warren-project-abc123");
      expect(output).toContain("Warren Session");
      expect(output).toContain("/path/to/session.yml");
      expect(output).toContain("/tmp/warren-project-abc123");
    });

    it("prints multiple config paths", () => {
      printPreamble(
        ["/path/to/base.yml", "/path/to/override.yml"],
        "/tmp/warren-project-abc123",
      );
      expect(output).toContain("/path/to/base.yml");
      expect(output).toContain("/path/to/override.yml");
    });
  });

  describe("printTranscriptPath", () => {
    it("prints SDK session path and divider", () => {
      printTranscriptPath("/home/user/.claude/projects/-tmp-foo/abc123.jsonl");
      expect(output).toContain(
        "/home/user/.claude/projects/-tmp-foo/abc123.jsonl",
      );
      expect(output).toContain("───");
    });
  });

  describe("printSessionStarted", () => {
    it("prints session started message", () => {
      printSessionStarted("abc-123");
      expect(output).toContain("[warren] Session started: abc-123");
    });
  });

  describe("printUserMessage", () => {
    it("prints user message with [User] header and indented content", () => {
      printUserMessage("Write a haiku about the ocean");
      expect(output).toContain("[User]");
      expect(output).toContain("    Write a haiku about the ocean");
    });

    it("indents multi-line content", () => {
      printUserMessage("Line one\nLine two");
      expect(output).toContain("    Line one\n    Line two");
    });
  });

  describe("printThinking", () => {
    it("prints thinking block with [Thinking] header and indented content", () => {
      printThinking("I should write a 5-7-5 haiku.");
      expect(output).toContain("[Thinking]");
      expect(output).toContain("    I should write a 5-7-5 haiku.");
    });
  });

  describe("printAssistantText", () => {
    it("prints [Assistant] header with indented text", () => {
      printAssistantText("Here is a haiku.");
      expect(output).toContain("[Assistant]");
      expect(output).toContain("    Here is a haiku.");
    });

    it("indents multi-line text", () => {
      printAssistantText("Line one\nLine two");
      expect(output).toContain("    Line one\n    Line two");
    });
  });

  describe("printToolUse", () => {
    it("prints [Tool] header with formatted tool line", () => {
      printToolUse("Write", { file_path: "/tmp/foo.txt" });
      expect(output).toContain("[Tool]");
      expect(output).toContain("    ⚙ Write /tmp/foo.txt");
    });

    it("abbreviates Read tool", () => {
      printToolUse("Read", { file_path: "/tmp/foo.txt" });
      expect(output).toContain("    ⚙ Read /tmp/foo.txt");
    });

    it("truncates long Bash commands", () => {
      const longCmd = "a".repeat(200);
      printToolUse("Bash", { command: longCmd });
      expect(output).toContain("⚙ Bash: " + "a".repeat(100) + "…");
    });

    it("abbreviates Glob tool", () => {
      printToolUse("Glob", { pattern: "**/*.ts" });
      expect(output).toContain("⚙ Glob **/*.ts");
    });

    it("abbreviates Grep tool", () => {
      printToolUse("Grep", { pattern: "function\\s+\\w+" });
      expect(output).toContain('⚙ Grep "function\\s+\\w+"');
    });

    it("shows generic format for unknown tools", () => {
      printToolUse("Agent", { prompt: "do something" });
      expect(output).toContain("⚙ Agent");
    });

    it("abbreviates Edit tool", () => {
      printToolUse("Edit", { file_path: "/tmp/bar.ts" });
      expect(output).toContain("⚙ Edit /tmp/bar.ts");
    });
  });

  describe("printOracleAskUser", () => {
    it("prints oracle answers", () => {
      printOracleAskUser(
        { "What language?": "Python" },
        "User prefers Python",
      );
      expect(output).toContain("⚡ Oracle");
      expect(output).toContain("Python");
    });
  });

  describe("printOracleTurnPolicy", () => {
    it("prints continue decision with message", () => {
      printOracleTurnPolicy(
        "continue",
        "Can you add tests?",
        "Task incomplete",
      );
      expect(output).toContain("⚡ Oracle");
      expect(output).toContain("continue");
    });

    it("prints end decision", () => {
      printOracleTurnPolicy("end", undefined, "Task complete");
      expect(output).toContain("⚡ Oracle");
      expect(output).toContain("end");
    });
  });

  describe("printSummary", () => {
    it("prints summary with paths and stats", () => {
      printSummary({
        configPaths: ["/path/to/session.yml"],
        projectDir: "/tmp/warren-project-abc123",
        sdkSessionPath: "/home/user/.claude/projects/-tmp-foo/abc.jsonl",
        turns: 5,
        toolCalls: 3,
        durationMs: 12345,
        totalCostUsd: 0.05,
      });
      expect(output).toContain("Summary");
      expect(output).toContain("/path/to/session.yml");
      expect(output).toContain("/tmp/warren-project-abc123");
      expect(output).toContain("5");
      expect(output).toContain("3");
      expect(output).toContain("12.3s");
      expect(output).toContain("$0.05");
    });

    it("omits cost when zero", () => {
      printSummary({
        configPaths: ["/path/to/session.yml"],
        projectDir: "/tmp/warren-project-abc123",
        sdkSessionPath: "/home/user/.claude/projects/-tmp-foo/abc.jsonl",
        turns: 1,
        toolCalls: 0,
        durationMs: 5000,
        totalCostUsd: 0,
      });
      expect(output).not.toContain("Cost");
    });
  });
});
