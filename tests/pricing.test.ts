import { afterEach, describe, expect, it } from "vitest";
import {
  OPENAI_DEFAULT_INPUT_USD_PER_MTOK,
  openAiPricedFromDefaults,
  priceOpenAi,
} from "../src/providers/openai.js";

const KEYS = [
  "OPENAI_USD_PER_MTOK_INPUT",
  "OPENAI_USD_PER_MTOK_OUTPUT",
  "OPENAI_USD_PER_MTOK_CACHED",
] as const;

describe("what an OpenAI call cost", () => {
  const originals = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const key of KEYS) {
      const value = originals[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("does not bill a cache read at the full input rate", () => {
    // prompt_tokens already includes the cached ones, and the old line read
    // cached_tokens and then ignored it - so every cache read was charged as
    // fresh input. On a cross-vendor run that is most of the reviewer's bill.
    process.env.OPENAI_USD_PER_MTOK_INPUT = "10";
    process.env.OPENAI_USD_PER_MTOK_OUTPUT = "0";
    process.env.OPENAI_USD_PER_MTOK_CACHED = "1";

    const allFresh = priceOpenAi(1_000_000, 0, 0);
    const allCached = priceOpenAi(1_000_000, 1_000_000, 0);

    expect(allFresh).toBeCloseTo(10);
    expect(allCached).toBeCloseTo(1);
  });

  it("uses the rates you configure, not a constant from another vendor", () => {
    // The hard-coded $5/$25 were Anthropic's Opus prices applied to GPT-5's
    // tokens: a run reported $6.68 off the wrong vendor's table, which makes
    // --max-usd a cap on a quantity nobody is charging.
    process.env.OPENAI_USD_PER_MTOK_INPUT = "1.25";
    process.env.OPENAI_USD_PER_MTOK_OUTPUT = "10";

    expect(priceOpenAi(1_000_000, 0, 0)).toBeCloseTo(1.25);
    expect(priceOpenAi(0, 0, 1_000_000)).toBeCloseTo(10);
    expect(openAiPricedFromDefaults()).toBe(false);
  });

  it("admits when it is guessing", () => {
    for (const key of KEYS) delete process.env[key];
    expect(openAiPricedFromDefaults()).toBe(true);
    expect(priceOpenAi(1_000_000, 0, 0)).toBeCloseTo(OPENAI_DEFAULT_INPUT_USD_PER_MTOK);
  });

  it("ignores a rate that is not a number rather than pricing at NaN", () => {
    process.env.OPENAI_USD_PER_MTOK_INPUT = "free";
    expect(priceOpenAi(1_000_000, 0, 0)).toBeCloseTo(OPENAI_DEFAULT_INPUT_USD_PER_MTOK);
  });
});
