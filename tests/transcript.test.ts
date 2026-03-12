import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  printPreamble,
  printTranscriptPath,
  printSessionStarted,
  printUserMessage,
  printThinking,
  printAssistantMessage,
  printToolResult,
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

  describe("printAssistantMessage", () => {
    it("prints text blocks under [Assistant] header with indentation", () => {
      const count = printAssistantMessage([
        { type: "text", text: "Here is a haiku." },
      ]);
      expect(output).toContain("[Assistant]");
      expect(output).toContain("    Here is a haiku.");
      expect(count).toBe(0);
    });

    it("prints thinking blocks with separate [Thinking] header", () => {
      printAssistantMessage([
        { type: "thinking", thinking: "Let me think..." },
        { type: "text", text: "Here is the answer." },
      ]);
      expect(output).toContain("[Thinking]");
      expect(output).toContain("    Let me think...");
      expect(output).toContain("[Assistant]");
      expect(output).toContain("    Here is the answer.");
      // Thinking should come before Assistant
      expect(output.indexOf("[Thinking]")).toBeLessThan(
        output.indexOf("[Assistant]"),
      );
    });

    it("groups text and tool_use under single [Assistant] header", () => {
      const count = printAssistantMessage([
        { type: "text", text: "I'll write a file." },
        { type: "tool_use", name: "Write", input: { file_path: "/tmp/foo.txt" }, id: "t1" },
      ]);
      expect(output).toContain("[Assistant]");
      expect(output).toContain("    I'll write a file.");
      expect(output).toContain("    ⚙ Write /tmp/foo.txt");
      // Only one [Assistant] header
      expect(output.match(/\[Assistant\]/g)?.length).toBe(1);
      expect(count).toBe(1);
    });

    it("consecutive tool_use blocks have no blank line between them", () => {
      printAssistantMessage([
        { type: "text", text: "Doing stuff:" },
        { type: "tool_use", name: "Bash", input: { command: "pwd" }, id: "t1" },
        { type: "tool_use", name: "Write", input: { file_path: "/tmp/f.txt" }, id: "t2" },
      ]);
      // Check that the two tool lines are adjacent (only \n between them)
      expect(output).toContain("    ⚙ Bash: pwd\n    ⚙ Write /tmp/f.txt");
    });

    it("abbreviates Read tool", () => {
      printAssistantMessage([
        { type: "tool_use", name: "Read", input: { file_path: "/tmp/foo.txt" }, id: "t1" },
      ]);
      expect(output).toContain("⚙ Read /tmp/foo.txt");
    });

    it("truncates long Bash commands", () => {
      const longCmd = "a".repeat(200);
      printAssistantMessage([
        { type: "tool_use", name: "Bash", input: { command: longCmd }, id: "t1" },
      ]);
      expect(output).toContain("⚙ Bash: " + "a".repeat(100) + "…");
    });

    it("abbreviates Glob tool", () => {
      printAssistantMessage([
        { type: "tool_use", name: "Glob", input: { pattern: "**/*.ts" }, id: "t1" },
      ]);
      expect(output).toContain("⚙ Glob **/*.ts");
    });

    it("abbreviates Grep tool", () => {
      printAssistantMessage([
        { type: "tool_use", name: "Grep", input: { pattern: "function\\s+\\w+" }, id: "t1" },
      ]);
      expect(output).toContain('⚙ Grep "function\\s+\\w+"');
    });

    it("shows generic format for unknown tools", () => {
      printAssistantMessage([
        { type: "tool_use", name: "Agent", input: { prompt: "do something" }, id: "t1" },
      ]);
      expect(output).toContain("⚙ Agent");
    });

    it("returns count of tool_use blocks", () => {
      const count = printAssistantMessage([
        { type: "text", text: "text" },
        { type: "tool_use", name: "Read", input: {}, id: "t1" },
        { type: "tool_use", name: "Write", input: {}, id: "t2" },
      ]);
      expect(count).toBe(2);
    });
  });

  describe("printToolResult", () => {
    it("prints success result", () => {
      printToolResult("tool-123", "File written successfully", false);
      expect(output).toContain("✓");
    });

    it("prints error result", () => {
      printToolResult("tool-123", "File not found", true);
      expect(output).toContain("✗");
    });

    it("truncates long results", () => {
      const longResult = "x".repeat(300);
      printToolResult("tool-123", longResult, false);
      // Should contain truncated content
      expect(output.length).toBeLessThan(350);
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
