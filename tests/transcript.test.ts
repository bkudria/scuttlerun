import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  writeHeader,
  writeUser,
  writeThinking,
  writeAssistant,
  writeTool,
  writeOracleAsk,
  writeOracleTurn,
  writeFooter,
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

  describe("writeHeader", () => {
    it("writes session, config, project, transcript and conversation header", () => {
      writeHeader({
        session: "abc-123",
        configPaths: ["/path/to/session.yml"],
        projectDir: "/tmp/warren-project-abc123",
        transcriptPath: "/home/user/.claude/projects/-tmp-foo/abc123.jsonl",
      });
      const parsed = parseYaml(output + "  - user: |\n      placeholder\n");
      expect(parsed.session).toBe("abc-123");
      expect(parsed.config).toBe("/path/to/session.yml");
      expect(parsed.project).toBe("/tmp/warren-project-abc123");
      expect(parsed.transcript).toBe("/home/user/.claude/projects/-tmp-foo/abc123.jsonl");
      expect(output).toContain("conversation:\n");
    });

    it("writes config as list for multiple paths", () => {
      writeHeader({
        session: "abc-123",
        configPaths: ["/path/to/base.yml", "/path/to/override.yml"],
        projectDir: "/tmp/warren-project-abc123",
        transcriptPath: "/home/user/.claude/projects/-tmp-foo/abc123.jsonl",
      });
      const parsed = parseYaml(output + "  - user: |\n      placeholder\n");
      expect(parsed.config).toEqual(["/path/to/base.yml", "/path/to/override.yml"]);
    });
  });

  describe("writeUser", () => {
    it("writes user entry as block scalar", () => {
      writeUser("Write a haiku about the ocean");
      const parsed = parseYaml("conversation:\n" + output);
      expect(parsed.conversation[0].user).toBe("Write a haiku about the ocean\n");
    });

    it("preserves multi-line content", () => {
      writeUser("Line one\nLine two");
      const parsed = parseYaml("conversation:\n" + output);
      expect(parsed.conversation[0].user).toBe("Line one\nLine two\n");
    });
  });

  describe("writeThinking", () => {
    it("writes thinking entry as block scalar", () => {
      writeThinking("I should write a 5-7-5 haiku.");
      const parsed = parseYaml("conversation:\n" + output);
      expect(parsed.conversation[0].thinking).toBe("I should write a 5-7-5 haiku.\n");
    });
  });

  describe("writeAssistant", () => {
    it("writes assistant entry as block scalar", () => {
      writeAssistant("Here is a haiku.");
      const parsed = parseYaml("conversation:\n" + output);
      expect(parsed.conversation[0].assistant).toBe("Here is a haiku.\n");
    });

    it("preserves multi-line content with markdown", () => {
      writeAssistant("Here it is:\n\n> *Waves crash*\n> *Salt wind*");
      const parsed = parseYaml("conversation:\n" + output);
      expect(parsed.conversation[0].assistant).toContain("> *Waves crash*");
      expect(parsed.conversation[0].assistant).toContain("> *Salt wind*");
    });
  });

  describe("writeTool", () => {
    it("writes Read with path", () => {
      writeTool("Read", { file_path: "/tmp/foo.txt" });
      const parsed = parseYaml("conversation:\n" + output);
      expect(parsed.conversation[0].tool).toBe("Read");
      expect(parsed.conversation[0].path).toBe("/tmp/foo.txt");
    });

    it("writes Write with path", () => {
      writeTool("Write", { file_path: "/tmp/foo.txt" });
      const parsed = parseYaml("conversation:\n" + output);
      expect(parsed.conversation[0].tool).toBe("Write");
      expect(parsed.conversation[0].path).toBe("/tmp/foo.txt");
    });

    it("writes Edit with path", () => {
      writeTool("Edit", { file_path: "/tmp/bar.ts" });
      const parsed = parseYaml("conversation:\n" + output);
      expect(parsed.conversation[0].tool).toBe("Edit");
      expect(parsed.conversation[0].path).toBe("/tmp/bar.ts");
    });

    it("writes Bash with command as block scalar", () => {
      writeTool("Bash", { command: "echo hello && pwd" });
      const parsed = parseYaml("conversation:\n" + output);
      expect(parsed.conversation[0].tool).toBe("Bash");
      expect(parsed.conversation[0].command).toBe("echo hello && pwd\n");
    });

    it("does not truncate long Bash commands", () => {
      const longCmd = "a".repeat(200);
      writeTool("Bash", { command: longCmd });
      const parsed = parseYaml("conversation:\n" + output);
      expect(parsed.conversation[0].command).toBe(longCmd + "\n");
    });

    it("writes Glob with single-quoted pattern", () => {
      writeTool("Glob", { pattern: "**/*.ts" });
      const parsed = parseYaml("conversation:\n" + output);
      expect(parsed.conversation[0].tool).toBe("Glob");
      expect(parsed.conversation[0].pattern).toBe("**/*.ts");
    });

    it("writes Grep with single-quoted pattern", () => {
      writeTool("Grep", { pattern: "function\\s+\\w+" });
      const parsed = parseYaml("conversation:\n" + output);
      expect(parsed.conversation[0].tool).toBe("Grep");
      expect(parsed.conversation[0].pattern).toBe("function\\s+\\w+");
    });

    it("writes unknown tools with input as YAML mapping", () => {
      writeTool("Agent", { prompt: "do something" });
      const parsed = parseYaml("conversation:\n" + output);
      expect(parsed.conversation[0].tool).toBe("Agent");
      expect(parsed.conversation[0].input.prompt).toBe("do something");
    });
  });

  describe("writeOracleAsk", () => {
    it("writes oracle ask_user entry with answers and reasoning", () => {
      writeOracleAsk(
        { "What language?": "Python" },
        "User prefers Python",
      );
      const parsed = parseYaml("conversation:\n" + output);
      const entry = parsed.conversation[0];
      expect(entry.oracle).toBe("ask_user");
      expect(entry.answers["What language?"]).toBe("Python");
      expect(entry.reasoning).toBe("User prefers Python");
    });
  });

  describe("writeOracleTurn", () => {
    it("writes continue decision with message and reasoning", () => {
      writeOracleTurn("continue", "Can you add tests?", "Task incomplete");
      const parsed = parseYaml("conversation:\n" + output);
      const entry = parsed.conversation[0];
      expect(entry.oracle).toBe("turn_policy");
      expect(entry.decision).toBe("continue");
      expect(entry.message).toContain("Can you add tests?");
      expect(entry.reasoning).toBe("Task incomplete");
    });

    it("writes end decision without message", () => {
      writeOracleTurn("end", undefined, "Task complete");
      const parsed = parseYaml("conversation:\n" + output);
      const entry = parsed.conversation[0];
      expect(entry.oracle).toBe("turn_policy");
      expect(entry.decision).toBe("end");
      expect(entry.message).toBeUndefined();
      expect(entry.reasoning).toBe("Task complete");
    });
  });

  describe("writeFooter", () => {
    it("writes stats as top-level YAML keys", () => {
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

    it("omits cost_usd when zero", () => {
      writeFooter({
        turns: 1,
        toolCalls: 0,
        durationMs: 5000,
        totalCostUsd: 0,
      });
      expect(output).not.toContain("cost_usd");
    });

    it("writes file lists when provided", () => {
      writeFooter({
        turns: 1,
        toolCalls: 3,
        durationMs: 5000,
        totalCostUsd: 0.01,
        filesWritten: ["/tmp/foo.txt"],
        filesEdited: ["/tmp/bar.ts"],
        filesRead: ["/tmp/baz.md", "/tmp/qux.ts"],
      });
      const parsed = parseYaml(output);
      expect(parsed.files_written).toEqual(["/tmp/foo.txt"]);
      expect(parsed.files_edited).toEqual(["/tmp/bar.ts"]);
      expect(parsed.files_read).toEqual(["/tmp/baz.md", "/tmp/qux.ts"]);
    });

    it("omits file lists when empty", () => {
      writeFooter({
        turns: 1,
        toolCalls: 0,
        durationMs: 5000,
        totalCostUsd: 0,
        filesWritten: [],
        filesEdited: [],
        filesRead: [],
      });
      expect(output).not.toContain("files_written");
      expect(output).not.toContain("files_edited");
      expect(output).not.toContain("files_read");
    });

    it("omits file lists when not provided", () => {
      writeFooter({
        turns: 1,
        toolCalls: 0,
        durationMs: 5000,
        totalCostUsd: 0,
      });
      expect(output).not.toContain("files_written");
      expect(output).not.toContain("files_edited");
      expect(output).not.toContain("files_read");
    });
  });
});
