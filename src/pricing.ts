export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

// Pricing last verified 2026-04; update when Anthropic publishes new rates.
const PRICES: Record<string, ModelPrice> = {
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-opus-4-7": { inputPerMTok: 15, outputPerMTok: 75 },
};

function getFamilyPrice(model: string): ModelPrice | undefined {
  if (model.includes("opus")) return PRICES["claude-opus-4-7"];
  if (model.includes("sonnet")) return PRICES["claude-sonnet-4-6"];
  if (model.includes("haiku")) return PRICES["claude-haiku-4-5"];
  return undefined;
}

const CACHE_CREATION_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number = 0,
  cacheReadTokens: number = 0,
): number {
  const price = PRICES[model] ?? getFamilyPrice(model) ?? PRICES["claude-haiku-4-5"];
  return (
    inputTokens * price.inputPerMTok +
    outputTokens * price.outputPerMTok +
    cacheCreationTokens * price.inputPerMTok * CACHE_CREATION_MULTIPLIER +
    cacheReadTokens * price.inputPerMTok * CACHE_READ_MULTIPLIER
  ) / 1_000_000;
}
