import { describe, it, expect } from "vitest";
import { computeCostUsd } from "../src/pricing.js";

describe("computeCostUsd", () => {
  it("computes haiku cost from tokens", () => {
    // 1M input @ $1/MTok + 1M output @ $5/MTok = $6
    expect(computeCostUsd("claude-haiku-4-5", 1_000_000, 1_000_000)).toBeCloseTo(6, 6);
  });

  it("computes sonnet cost from tokens", () => {
    // 500k input @ $3/MTok + 500k output @ $15/MTok = $1.5 + $7.5 = $9
    expect(computeCostUsd("claude-sonnet-4-6", 500_000, 500_000)).toBeCloseTo(9, 6);
  });

  it("computes zero for zero tokens", () => {
    expect(computeCostUsd("claude-haiku-4-5", 0, 0)).toBe(0);
  });

  it("falls back to haiku pricing for unrecognized models", () => {
    const unknown = computeCostUsd("claude-experimental-0", 1000, 1000);
    const haiku = computeCostUsd("claude-haiku-4-5", 1000, 1000);
    expect(unknown).toBeCloseTo(haiku, 10);
  });

  it("matches opus family variants (e.g., 1M-context suffix) to opus rates", () => {
    const variant = computeCostUsd("claude-opus-4-7[1m]", 1000, 1000);
    const opus = computeCostUsd("claude-opus-4-7", 1000, 1000);
    expect(variant).toBeCloseTo(opus, 10);
  });

  it("matches sonnet family variants to sonnet rates", () => {
    const variant = computeCostUsd("claude-sonnet-4-6-preview", 1000, 1000);
    const sonnet = computeCostUsd("claude-sonnet-4-6", 1000, 1000);
    expect(variant).toBeCloseTo(sonnet, 10);
  });

  it("matches haiku family variants to haiku rates", () => {
    const variant = computeCostUsd("claude-haiku-5-0-preview", 1000, 1000);
    const haiku = computeCostUsd("claude-haiku-4-5", 1000, 1000);
    expect(variant).toBeCloseTo(haiku, 10);
  });

  it("matches future opus releases to current opus rates", () => {
    const future = computeCostUsd("claude-opus-5-0", 1000, 1000);
    const opus = computeCostUsd("claude-opus-4-7", 1000, 1000);
    expect(future).toBeCloseTo(opus, 10);
  });

  it("falls back to the configured default model's rate when family matching also fails", () => {
    // An unknown model (no opus/sonnet/haiku in name) priced with a configured
    // default model that uses a *different* rate from haiku must charge the
    // default model's rate, not the hard-coded haiku literal.
    const unknown = computeCostUsd(
      "claude-fictional-9-9",
      1_000_000,
      1_000_000,
      0,
      0,
      "claude-opus-4-7",
    );
    const opus = computeCostUsd("claude-opus-4-7", 1_000_000, 1_000_000);
    const haiku = computeCostUsd("claude-haiku-4-5", 1_000_000, 1_000_000);
    expect(unknown).toBeCloseTo(opus, 10);
    expect(unknown).not.toBeCloseTo(haiku, 6);
  });

  it("falls back to haiku rates when both model and defaultModel are unknown", () => {
    // Defensive last-resort: if neither the model nor the configured default
    // model resolves (direct match or family match), we still produce a
    // sensible price using the haiku rate rather than NaN.
    const result = computeCostUsd(
      "claude-fictional-9-9",
      1_000_000,
      1_000_000,
      0,
      0,
      "claude-also-fictional-0",
    );
    const haiku = computeCostUsd("claude-haiku-4-5", 1_000_000, 1_000_000);
    expect(result).toBeCloseTo(haiku, 10);
  });
});

describe("cache token pricing", () => {
  it("prices cache_creation_input_tokens at 1.25x input rate (haiku)", () => {
    expect(computeCostUsd("claude-haiku-4-5", 0, 0, 1_000_000, 0)).toBeCloseTo(1.25, 6);
  });

  it("prices cache_read_input_tokens at 0.1x input rate (haiku)", () => {
    expect(computeCostUsd("claude-haiku-4-5", 0, 0, 0, 1_000_000)).toBeCloseTo(0.1, 6);
  });

  it("scales cache rates with model family (sonnet)", () => {
    // sonnet input rate is $3/MTok: 1M creation * 1.25 + 1M read * 0.1
    expect(computeCostUsd("claude-sonnet-4-6", 0, 0, 1_000_000, 1_000_000)).toBeCloseTo(
      3 * 1.25 + 3 * 0.1,
      6,
    );
  });

  it("sums input + output + cache_creation + cache_read correctly (haiku)", () => {
    // haiku: $1/MTok input, $5/MTok output, $1.25/MTok cache_creation, $0.10/MTok cache_read
    // 100k input + 50k output + 200k cache_creation + 800k cache_read
    // = 0.1 + 0.25 + 0.25 + 0.08 = 0.68
    expect(computeCostUsd("claude-haiku-4-5", 100_000, 50_000, 200_000, 800_000)).toBeCloseTo(
      0.68,
      6,
    );
  });

  it("treats omitted cache params as zero (3-arg signature regression guard)", () => {
    expect(computeCostUsd("claude-haiku-4-5", 1_000_000, 1_000_000)).toBe(6);
  });
});
