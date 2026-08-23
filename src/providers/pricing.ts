/**
 * USD per million tokens. Used for the spend guardrail, which is the only thing
 * standing between an unattended swarm and an unbounded bill, so an unknown
 * model is priced pessimistically rather than free.
 */
export interface Price {
  input: number;
  output: number;
  /** Cache reads are typically a tenth of input; writes a little above it. */
  cachedInput?: number;
}

const PRICES: Record<string, Price> = {
  // Anthropic
  "claude-opus-5": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-sonnet-5": { input: 3, output: 15, cachedInput: 0.3 },
  "claude-sonnet-4-6": { input: 3, output: 15, cachedInput: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cachedInput: 0.1 },
  "claude-fable-5": { input: 10, output: 50, cachedInput: 1 },
};

/** Deliberately high, so an unpriced model trips the cap early instead of late. */
const UNKNOWN: Price = { input: 15, output: 75, cachedInput: 1.5 };

export function priceFor(model: string): Price {
  return PRICES[model] ?? UNKNOWN;
}

export function isPriced(model: string): boolean {
  return model in PRICES;
}

export function costUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number {
  const price = priceFor(model);
  const cached = price.cachedInput ?? price.input * 0.1;
  return (
    (inputTokens / 1_000_000) * price.input +
    (outputTokens / 1_000_000) * price.output +
    (cachedInputTokens / 1_000_000) * cached
  );
}
