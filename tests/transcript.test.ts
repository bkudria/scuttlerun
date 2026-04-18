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
        configPaths: ["/path/to/session.yaml"],
        projectDir: "/tmp/scuttlerun-project-abc123",
        transcriptPath: "/home/user/.claude/projects/-tmp-foo/abc123.jsonl",
      });
      const parsed = parseYaml(output + "  - user: |\n      placeholder\n");
      expect(parsed.session).toBe("abc-123");
      expect(parsed.config).toBe("/path/to/session.yaml");
      expect(parsed.project).toBe("/tmp/scuttlerun-project-abc123");
      expect(parsed.transcript).toBe("/home/user/.claude/projects/-tmp-foo/abc123.jsonl");
      expect(output).toContain("conversation:\n");
    });

    it("starts with YAML document start marker", () => {
      writeHeader({
        session: "abc-123",
        configPaths: ["/path/to/session.yaml"],
        projectDir: "/tmp/proj",
        transcriptPath: "/tmp/transcript.jsonl",
      });
      expect(output).toMatch(/^---\n/);
    });

    it("writes config as list for multiple paths", () => {
      writeHeader({
        session: "abc-123",
        configPaths: ["/path/to/base.yaml", "/path/to/override.yaml"],
        projectDir: "/tmp/scuttlerun-project-abc123",
        transcriptPath: "/home/user/.claude/projects/-tmp-foo/abc123.jsonl",
      });
      const parsed = parseYaml(output + "  - user: |\n      placeholder\n");
      expect(parsed.config).toEqual(["/path/to/base.yaml", "/path/to/override.yaml"]);
    });
  });

  describe("writeUser", () => {
    it("writes user entry as block scalar", () => {
      writeUser("Write a haiku about the ocean");
      const parsed = parseYaml("conversation:\n" + output);
      expect(parsed.conversation[0].user).toBe("Write a haiku about the ocean");
    });

    it("preserves multi-line content", () => {
      writeUser("Line one\nLine two");
      const parsed = parseYaml("conversation:\n" + output);
      expect(parsed.conversation[0].user).toBe("Line one\nLine two");
    });
  });

  describe("writeThinking", () => {
    it("writes thinking entry as block scalar", () => {
      writeThinking("I should write a 5-7-5 haiku.");
      const parsed = parseYaml("conversation:\n" + output);
      expect(parsed.conversation[0].thinking).toBe("I should write a 5-7-5 haiku.");
    });
  });

  describe("writeAssistant", () => {
    it("writes assistant entry as block scalar", () => {
      writeAssistant("Here is a haiku.");
      const parsed = parseYaml("conversation:\n" + output);
      expect(parsed.conversation[0].assistant).toBe("Here is a haiku.");
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
      expect(parsed.conversation[0].command).toBe("echo hello && pwd");
    });

    it("does not truncate long Bash commands", () => {
      const longCmd = "a".repeat(200);
      writeTool("Bash", { command: longCmd });
      const parsed = parseYaml("conversation:\n" + output);
      expect(parsed.conversation[0].command).toBe(longCmd);
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

    it("handles missing file_path in Read/Write/Edit", () => {
      writeTool("Read", {});
      expect(output).toContain("path:");
    });

    it("handles missing command in Bash", () => {
      writeTool("Bash", {});
      expect(output).toContain("command:");
    });

    it("handles missing pattern in Glob", () => {
      writeTool("Glob", {});
      expect(output).toContain("pattern:");
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

    it("handles multiline question keys", () => {
      writeOracleAsk(
        { "Which option do you prefer?\nOption A or Option B": "Option A" },
        "Clear preference",
      );
      const parsed = parseYaml("conversation:\n" + output);
      const entry = parsed.conversation[0];
      expect(entry.oracle).toBe("ask_user");
      const key = Object.keys(entry.answers)[0];
      expect(key).toContain("Which option do you prefer?");
      expect(key).toContain("Option A or Option B");
      expect(Object.values(entry.answers)[0]).toBe("Option A");
    });

    it("handles multiline answer values as block scalars", () => {
      writeOracleAsk(
        { "What should I do?": "First do X.\nThen do Y.\nFinally do Z." },
        "Step by step",
      );
      const parsed = parseYaml("conversation:\n" + output);
      const entry = parsed.conversation[0];
      expect(entry.answers["What should I do?"]).toContain("First do X.");
      expect(entry.answers["What should I do?"]).toContain("Then do Y.");
      expect(entry.answers["What should I do?"]).toContain("Finally do Z.");
    });

    it("handles YAML-special characters in question keys", () => {
      writeOracleAsk(
        { "Use {braces}: yes or #no?": "yes" },
        "Confirmed",
      );
      const parsed = parseYaml("conversation:\n" + output);
      const entry = parsed.conversation[0];
      expect(entry.answers["Use {braces}: yes or #no?"]).toBe("yes");
    });

    it("handles multiline reasoning as block scalar", () => {
      writeOracleAsk(
        { "Language?": "Python" },
        "The user mentioned Python earlier.\nThey also have a .py file in the project.",
      );
      const parsed = parseYaml("conversation:\n" + output);
      const entry = parsed.conversation[0];
      expect(entry.reasoning).toContain("The user mentioned Python earlier.");
      expect(entry.reasoning).toContain("They also have a .py file in the project.");
    });

    it("handles long reasoning without line wrapping", () => {
      writeOracleAsk(
        { "Language?": "Python" },
        "As a Python enthusiast who prefers simple, readable code, Python is the natural choice. It aligns perfectly with the stated preference for simplicity.",
      );
      const parsed = parseYaml("conversation:\n" + output);
      const entry = parsed.conversation[0];
      expect(entry.reasoning).toContain("Python is the natural choice");
    });
  });

  describe("writeOracleTurn", () => {
    it("writes continue decision with message and reasoning", () => {
      writeOracleTurn("continue", "Can you add tests?", "Task incomplete");
      const parsed = parseYaml("conversation:\n" + output);
      const entry = parsed.conversation[0];
      expect(entry.oracle).toBe("turn");
      expect(entry.decision).toBe("continue");
      expect(entry.message).toContain("Can you add tests?");
      expect(entry.reasoning).toBe("Task incomplete");
    });

    it("handles multiline reasoning as block scalar", () => {
      writeOracleTurn("continue", "Add tests", "Task is incomplete.\nTests are missing.");
      const parsed = parseYaml("conversation:\n" + output);
      const entry = parsed.conversation[0];
      expect(entry.reasoning).toContain("Task is incomplete.");
      expect(entry.reasoning).toContain("Tests are missing.");
    });

    it("writes end decision without message", () => {
      writeOracleTurn("end", undefined, "Task complete");
      const parsed = parseYaml("conversation:\n" + output);
      const entry = parsed.conversation[0];
      expect(entry.oracle).toBe("turn");
      expect(entry.decision).toBe("end");
      expect(entry.message).toBeUndefined();
      expect(entry.reasoning).toBe("Task complete");
    });

    it("writes decision without reasoning", () => {
      writeOracleTurn("end");
      const parsed = parseYaml("conversation:\n" + output);
      const entry = parsed.conversation[0];
      expect(entry.oracle).toBe("turn");
      expect(entry.decision).toBe("end");
      expect(entry.reasoning).toBeUndefined();
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

    it("includes oracle_usage when provided", () => {
      writeFooter({
        turns: 3,
        toolCalls: 5,
        durationMs: 12000,
        totalCostUsd: 0.05,
        oracleUsage: { input_tokens: 1500, output_tokens: 200, calls: 4 },
      });
      expect(output).toContain("oracle_usage:");
      expect(output).toContain("input_tokens: 1500");
      expect(output).toContain("output_tokens: 200");
      expect(output).toContain("calls: 4");
    });

    it("omits oracle_usage when calls is 0", () => {
      writeFooter({
        turns: 1,
        toolCalls: 0,
        durationMs: 5000,
        totalCostUsd: 0,
        oracleUsage: { input_tokens: 0, output_tokens: 0, calls: 0 },
      });
      expect(output).not.toContain("oracle_usage");
    });

    it("emits timed_out: true when the session timed out", () => {
      writeFooter({
        turns: 1,
        toolCalls: 0,
        durationMs: 300_000,
        totalCostUsd: 0,
        timedOut: true,
      });
      expect(output).toContain("timed_out: true");
    });

    it("omits timed_out when not timed out", () => {
      writeFooter({
        turns: 1,
        toolCalls: 0,
        durationMs: 5000,
        totalCostUsd: 0,
      });
      expect(output).not.toContain("timed_out");
    });
  });
});
