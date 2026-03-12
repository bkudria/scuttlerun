import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventRecorder, type WarrenEvent } from "../src/events.js";

describe("EventRecorder", () => {
  let tempDir: string;
  let outputPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), "warren-events-test-"));
    outputPath = join(tempDir, "events.jsonl");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("writes a session_start event with immediate flush", async () => {
    const recorder = new EventRecorder(outputPath, "session-123");
    await recorder.writeEvent("session_start", {
      config: { prompt: "test" },
      warren_version: "0.1.0",
      sdk_session_path: "/tmp/session.jsonl",
    });

    const content = await fs.readFile(outputPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const event = JSON.parse(lines[0]) as WarrenEvent;
    expect(event.type).toBe("session_start");
    expect(event.session_id).toBe("session-123");
    expect(event.data.warren_version).toBe("0.1.0");
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("writes multiple events as separate JSONL lines", async () => {
    const recorder = new EventRecorder(outputPath, "session-456");
    await recorder.writeEvent("session_start", {
      config: {},
      warren_version: "0.1.0",
      sdk_session_path: "/tmp/s.jsonl",
    });
    await recorder.writeEvent("ask_user_question", {
      tool_use_id: "tool-1",
      questions: [{ question: "Pick one", options: ["a", "b"] }],
      oracle_response: { answers: { "Pick one": "a" }, reasoning: "first" },
      oracle_model: "claude-haiku-4-5",
      oracle_usage: { input_tokens: 100, output_tokens: 50 },
    });

    const content = await fs.readFile(outputPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const event1 = JSON.parse(lines[0]);
    const event2 = JSON.parse(lines[1]);
    expect(event1.type).toBe("session_start");
    expect(event2.type).toBe("ask_user_question");
    expect(event2.data.tool_use_id).toBe("tool-1");
  });

  it("writes turn_policy events", async () => {
    const recorder = new EventRecorder(outputPath, "s1");
    await recorder.writeEvent("turn_policy", {
      decision: "continue",
      message: "Can you also add a title?",
      reasoning: "Task incomplete",
      oracle_model: "claude-haiku-4-5",
      oracle_usage: { input_tokens: 200, output_tokens: 80 },
    });

    const content = await fs.readFile(outputPath, "utf8");
    const event = JSON.parse(content.trim());
    expect(event.type).toBe("turn_policy");
    expect(event.data.decision).toBe("continue");
    expect(event.data.message).toBe("Can you also add a title?");
  });

  it("writes error events", async () => {
    const recorder = new EventRecorder(outputPath, "s1");
    await recorder.writeEvent("error", {
      error_type: "oracle_failure",
      message: "API call failed after retry",
      recoverable: false,
    });

    const content = await fs.readFile(outputPath, "utf8");
    const event = JSON.parse(content.trim());
    expect(event.type).toBe("error");
    expect(event.data.recoverable).toBe(false);
  });

  it("writes session_end events with aggregated oracle usage", async () => {
    const recorder = new EventRecorder(outputPath, "s1");
    await recorder.writeEvent("session_end", {
      stop_reason: "end_turn",
      subtype: "success",
      is_error: false,
      total_turns: 3,
      total_cost_usd: 0.05,
      duration_ms: 12000,
      oracle_usage_total: {
        input_tokens: 500,
        output_tokens: 200,
        calls: 2,
      },
    });

    const content = await fs.readFile(outputPath, "utf8");
    const event = JSON.parse(content.trim());
    expect(event.type).toBe("session_end");
    expect(event.data.oracle_usage_total.calls).toBe(2);
  });

  it("writes agent_stderr events (buffered, no fsync)", async () => {
    const recorder = new EventRecorder(outputPath, "s1");
    await recorder.writeEvent("agent_stderr", {
      text: "some debug output\nmore output",
    });

    const content = await fs.readFile(outputPath, "utf8");
    const event = JSON.parse(content.trim());
    expect(event.type).toBe("agent_stderr");
    expect(event.data.text).toContain("some debug output");
  });
});
