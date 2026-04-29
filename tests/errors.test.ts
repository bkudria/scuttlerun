import { describe, it, expect } from "vitest";
import { z } from "zod";
import { formatZodError, formatCliError } from "../src/errors.js";
import { parseSessionConfig } from "../src/config.js";

describe("formatZodError", () => {
  it("formats a single root-level Zod issue", () => {
    const result = z.object({ prompt: z.string() }).safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;
    const out = formatZodError(result.error);
    expect(out).toBe("  - prompt: Invalid input: expected string, received undefined");
  });

  it("renders nested paths joined by dots", () => {
    const schema = z.object({
      user: z.object({ oracle_model: z.string() }),
    });
    const result = schema.safeParse({ user: { oracle_model: 42 } });
    expect(result.success).toBe(false);
    if (result.success) return;
    const out = formatZodError(result.error);
    expect(out).toMatch(/^ {2}- user\.oracle_model: /);
  });

  it("renders multiple issues on separate lines", () => {
    const schema = z.object({ a: z.string(), b: z.number() });
    const result = schema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;
    const out = formatZodError(result.error);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^ {2}- a: /);
    expect(lines[1]).toMatch(/^ {2}- b: /);
  });

  it("renders root issues with (root) marker when path is empty", () => {
    const result = z.string().safeParse(42);
    expect(result.success).toBe(false);
    if (result.success) return;
    const out = formatZodError(result.error);
    expect(out).toMatch(/^ {2}- \(root\): /);
  });
});

describe("formatCliError", () => {
  it("prefixes ZodError output with a Configuration error header", () => {
    const result = z.object({ prompt: z.string() }).safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;
    const out = formatCliError(result.error);
    expect(out).toBe(
      "[scuttlerun] Configuration error:\n  - prompt: Invalid input: expected string, received undefined",
    );
  });

  it("formats ENOENT errors as 'Config file not found'", () => {
    const err = Object.assign(new Error("ENOENT"), {
      code: "ENOENT",
      path: "/nope.yaml",
    });
    expect(formatCliError(err)).toBe(
      "[scuttlerun] Config file not found: /nope.yaml",
    );
  });

  it("falls back to (unknown) when ENOENT has no path field", () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    expect(formatCliError(err)).toBe(
      "[scuttlerun] Config file not found: (unknown)",
    );
  });

  it("formats generic Error with original message", () => {
    expect(formatCliError(new Error("boom"))).toBe("[scuttlerun] Error: boom");
  });

  it("stringifies non-Error throws", () => {
    expect(formatCliError("raw string")).toBe("[scuttlerun] Error: raw string");
  });

  it("handles a real parseSessionConfig failure end-to-end", () => {
    let caught: unknown;
    try {
      parseSessionConfig({});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(z.ZodError);
    const out = formatCliError(caught);
    expect(out.startsWith("[scuttlerun] Configuration error:\n")).toBe(true);
    expect(out).toContain("prompt:");
  });
});
