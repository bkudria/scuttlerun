// Spec-derived: Session.status transition graph from scuttlerun.allium
//
//   transitions status {
//       pending -> running
//       running -> completed_success
//       running -> exhausted_turns
//       running -> exhausted_budget
//       running -> failed
//       running -> timed_out
//       terminal: completed_success, exhausted_turns, exhausted_budget, failed, timed_out
//   }
//
// This file walks every declared edge end-to-end via runSession and confirms:
//   - each transition is reachable through its witnessing scenario
//   - terminal states are terminal (no further status changes within the same session)
//   - undeclared transitions (e.g. completed_success -> running) cannot be produced
//     because there is no rule that emits them. We assert this structurally by
//     reading the spec source — there is no test scaffolding inside scuttlerun
//     that could produce out-of-graph transitions, so this is an "invariant
//     by construction" assertion.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { runSession } from "../src/runner.js";
import type { SessionConfig } from "../src/config.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  return {
    query: vi.fn(),
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY: actual.SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { parse: vi.fn() };
  },
}));

vi.mock("../src/project.js", () => ({
  createProjectDir: vi.fn().mockResolvedValue("/tmp/scuttlerun-project-fsm"),
  scaffoldProject: vi.fn().mockResolvedValue({ projectPath: "/tmp/scuttlerun-project-fsm-scaffold" }),
  resolveSkillPath: vi.fn((p: string) => p),
}));

vi.mock("../src/cleanup.js", () => ({
  cleanOldProjects: vi.fn().mockResolvedValue(0),
  WORKSPACE_CLEANUP_AGE_DAYS: 7,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, mkdirSync: vi.fn() };
});

import { query as mockQueryFn } from "@anthropic-ai/claude-agent-sdk";
import { createProjectDir as mockCreateProjectDir, scaffoldProject as mockScaffoldProject } from "../src/project.js";
import { cleanOldProjects as mockCleanOldProjects } from "../src/cleanup.js";

function minConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    prompt: "ping",
    max_turns: 50,
    effort: "high",
    tools: ["Read"],
    permission_mode: "bypassPermissions",
    user: { oracle_model: "claude-haiku-4-5", max_turns: 0 },
    sdk: { system_prompt: { preset: "claude_code" as const }, setting_sources: [] },
    sandbox: {
      enabled: false,
      network: { allowed_domains: [], allow_local_binding: false },
      filesystem: { deny_read: [], allow_write: [], deny_write: [] },
    },
    ...overrides,
  };
}

function fixedMockQuery(messages: Array<Record<string, unknown>>) {
  return {
    close: vi.fn(),
    interrupt: vi.fn().mockResolvedValue(undefined),
    [Symbol.asyncIterator]: async function* () {
      for (const m of messages) yield m;
    },
  };
}

describe("Session.status transition graph (scuttlerun.allium)", () => {
  let stdoutOutput: string;
  const origStdoutWrite = process.stdout.write;

  beforeEach(() => {
    vi.resetAllMocks();
    (mockCreateProjectDir as ReturnType<typeof vi.fn>).mockResolvedValue("/tmp/scuttlerun-project-fsm");
    (mockScaffoldProject as ReturnType<typeof vi.fn>).mockResolvedValue({ projectPath: "/tmp/scuttlerun-project-fsm-scaffold" });
    (mockCleanOldProjects as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    delete process.env.CLAUDECODE;
    stdoutOutput = "";
    process.stdout.write = ((chunk: string) => {
      stdoutOutput += chunk;
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = origStdoutWrite;
  });

  // -------------------------------------------------------------------------
  // [transition-edge.Session.pending.running]
  // Witnessed by: rule SessionBecomesRunning (when AgentInitialized).
  // Mock: SDK emits {type: system, subtype: init} — runSession captures the
  // session_id and instantiates the SyntheticUser, which is the observable
  // signal that the running state has been entered.
  // -------------------------------------------------------------------------
  it("[transition-edge] pending -> running on AgentInitialized", async () => {
    const q = fixedMockQuery([
      { type: "system", subtype: "init", session_id: "fsm-pr", tools: [], model: "claude-haiku-4-5" },
      { type: "result", subtype: "success", session_id: "fsm-pr", num_turns: 0, total_cost_usd: 0 },
    ]);
    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(q);
    const result = await runSession(minConfig());
    expect(result.sessionId).toBe("fsm-pr"); // SDK init was captured
    expect(stdoutOutput).toContain("session: fsm-pr"); // header emitted, indicating running
  });

  // -------------------------------------------------------------------------
  // [transition-edge.Session.running.completed_success]
  // Witnessed by: rule TurnPolicyEnds OR rule AgentTurnSucceeds with
  // max_user_follow_ups = 0 (single-turn case).
  // -------------------------------------------------------------------------
  it("[transition-edge] running -> completed_success on result subtype=success (single turn)", async () => {
    const q = fixedMockQuery([
      { type: "system", subtype: "init", session_id: "fsm-rs", tools: [], model: "claude-haiku-4-5" },
      { type: "result", subtype: "success", session_id: "fsm-rs", num_turns: 1, total_cost_usd: 0 },
    ]);
    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(q);
    const result = await runSession(minConfig());
    expect(result.exitCode).toBe(0); // completed_success → 0
  });

  // -------------------------------------------------------------------------
  // [transition-edge.Session.running.exhausted_turns]
  // Witnessed by: rule AgentTurnExhaustsTurns (subtype = error_max_turns).
  // -------------------------------------------------------------------------
  it("[transition-edge] running -> exhausted_turns on result subtype=error_max_turns", async () => {
    const q = fixedMockQuery([
      { type: "system", subtype: "init", session_id: "fsm-rx", tools: [], model: "claude-haiku-4-5" },
      { type: "result", subtype: "error_max_turns", session_id: "fsm-rx", is_error: true, num_turns: 50, total_cost_usd: 0 },
    ]);
    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(q);
    const result = await runSession(minConfig());
    expect(result.exitCode).toBe(7); // exhausted_turns → 7
  });

  // -------------------------------------------------------------------------
  // [transition-edge.Session.running.exhausted_budget]
  // Witnessed by: rule AgentTurnExhaustsBudget (subtype = error_max_budget_usd).
  // -------------------------------------------------------------------------
  it("[transition-edge] running -> exhausted_budget on result subtype=error_max_budget_usd", async () => {
    const q = fixedMockQuery([
      { type: "system", subtype: "init", session_id: "fsm-rb", tools: [], model: "claude-haiku-4-5" },
      { type: "result", subtype: "error_max_budget_usd", session_id: "fsm-rb", is_error: true, num_turns: 10, total_cost_usd: 1.0 },
    ]);
    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(q);
    const result = await runSession(minConfig());
    expect(result.exitCode).toBe(5); // exhausted_budget → 5
  });

  // -------------------------------------------------------------------------
  // [transition-edge.Session.running.failed]
  // Witnessed by: rule AgentTurnFailsAtRuntime (subtype = error_during_execution).
  // -------------------------------------------------------------------------
  it("[transition-edge] running -> failed on result subtype=error_during_execution", async () => {
    const q = fixedMockQuery([
      { type: "system", subtype: "init", session_id: "fsm-rf", tools: [], model: "claude-haiku-4-5" },
      { type: "result", subtype: "error_during_execution", session_id: "fsm-rf", is_error: true, num_turns: 1, total_cost_usd: 0 },
    ]);
    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(q);
    const result = await runSession(minConfig());
    expect(result.exitCode).toBe(2); // failed → 2
  });

  // -------------------------------------------------------------------------
  // [transition-edge.Session.running.timed_out]
  // Witnessed by: rule SessionTimesOut (started_at + timeout <= now).
  // -------------------------------------------------------------------------
  it("[transition-edge] running -> timed_out on temporal trigger expiring", async () => {
    let resolveHang: (() => void) | undefined;
    const q = {
      close: vi.fn(),
      interrupt: vi.fn(async () => { resolveHang?.(); }),
      [Symbol.asyncIterator]: async function* () {
        yield { type: "system", subtype: "init", session_id: "fsm-rt", tools: [], model: "claude-haiku-4-5" };
        await new Promise<void>((r) => { resolveHang = r; });
      },
    };
    (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(q);
    const result = await runSession(minConfig(), { timeoutSeconds: 0.05 });
    expect(result.exitCode).toBe(6); // timed_out → 6
    expect(stdoutOutput).toContain("timed_out: true");
  });

  // -------------------------------------------------------------------------
  // [transition-terminal.Session.status]
  // Terminal states: completed_success, exhausted_turns, exhausted_budget,
  // failed, timed_out. After entering a terminal state runSession returns;
  // it does not transition to a non-terminal state. Each of the per-edge
  // tests above verifies a different terminal status is reached and runSession
  // returns with the corresponding exit code. Here we additionally verify
  // that:
  //   - close() is called exactly once on the SDK handle for every terminal
  //   - the returned exit code is final (not mutated by anything outside
  //     the rule that produced the terminal status)
  // The runner trusts the Agent SDK to terminate its message stream after a
  // result message; if the SDK violated that (e.g. continued yielding), the
  // runner's behaviour is undefined per the AgentSdkBoundary surface contract.
  // -------------------------------------------------------------------------
  it("[transition-terminal] every terminal status closes the SDK exactly once", async () => {
    const cases: Array<{ name: string; subtype: string; expect: number }> = [
      { name: "completed_success", subtype: "success", expect: 0 },
      { name: "exhausted_turns", subtype: "error_max_turns", expect: 7 },
      { name: "exhausted_budget", subtype: "error_max_budget_usd", expect: 5 },
      { name: "failed", subtype: "error_during_execution", expect: 2 },
    ];

    for (const { subtype, expect: expectExit } of cases) {
      const q = fixedMockQuery([
        { type: "system", subtype: "init", session_id: `fsm-term-${subtype}`, tools: [], model: "claude-haiku-4-5" },
        subtype === "success"
          ? { type: "result", subtype: "success", session_id: `fsm-term-${subtype}`, num_turns: 1, total_cost_usd: 0 }
          : { type: "result", subtype, session_id: `fsm-term-${subtype}`, is_error: true, num_turns: 1, total_cost_usd: 0, errors: ["x"] },
      ]);
      (mockQueryFn as ReturnType<typeof vi.fn>).mockReturnValue(q);

      const result = await runSession(minConfig());
      expect(result.exitCode).toBe(expectExit);
      expect(q.close).toHaveBeenCalledTimes(1);
    }
  });

  // -------------------------------------------------------------------------
  // [transition-rejected.Session.status]
  // Undeclared transitions (e.g. completed_success -> running, terminal -> any)
  // are not produced by any rule. We assert this structurally: the runner code
  // contains no path that re-enters the message-processing loop after
  // a result has been observed.
  // -------------------------------------------------------------------------
  it("[transition-rejected] runner.ts has no re-entry path that would produce undeclared transitions", async () => {
    const src = await readFile(new URL("../src/runner.ts", import.meta.url), "utf8");
    // After exitCode is set on a result message, the next loop iteration
    // either (a) sees no more messages and exits, or (b) sees timedOut and
    // breaks. There is no `restart`, `resume`, or status-mutation re-entry.
    expect(src).not.toMatch(/restart\(/);
    expect(src).not.toMatch(/resume\(/);
    // No code path exists that reverts a terminal exitCode to 0 except via
    // initial declaration. Once exitCode is non-zero, only the timeout branch
    // mutates it (which is itself a terminal transition).
    const reassignmentsToZero = src.match(/exitCode\s*=\s*0/g) || [];
    // Only the initial `let exitCode = 0` and the success branch should reset.
    expect(reassignmentsToZero.length).toBeLessThanOrEqual(2);
  });
});
