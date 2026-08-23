import { describe, expect, it } from "vitest";
import { Budget, BudgetExceededError } from "../src/kernel/budget.js";
import { ZERO_USAGE } from "../src/types.js";

function budget(overrides: Partial<ConstructorParameters<typeof Budget>[0]> = {}) {
  return new Budget({
    maxRunUsd: 1,
    maxAgentUsd: 0.5,
    maxTurnsPerTask: 10,
    maxWallClockMs: 60_000,
    ...overrides,
  });
}

const spend = (costUsd: number) => ({ ...ZERO_USAGE, costUsd });

describe("Budget", () => {
  it("permits calls below every cap", () => {
    const b = budget();
    b.charge("builder-1", spend(0.1));
    expect(() => b.check("builder-1")).not.toThrow();
  });

  it("stops the run once the run cap is reached", () => {
    const b = budget();
    b.charge("builder-1", spend(0.4));
    b.charge("builder-2", spend(0.7));
    expect(() => b.check("builder-3")).toThrow(BudgetExceededError);
  });

  it("stops one agent without stopping the others", () => {
    const b = budget();
    b.charge("builder-1", spend(0.5));
    expect(() => b.check("builder-1")).toThrow(/agent builder-1/);
    expect(() => b.check("builder-2")).not.toThrow();
  });

  it("stops the run when wall clock is exhausted", () => {
    const b = budget({ maxWallClockMs: -1 });
    expect(() => b.check("builder-1")).toThrow(/wall-clock/);
  });

  it("accumulates token counts across agents", () => {
    const b = budget();
    b.charge("a", { ...ZERO_USAGE, inputTokens: 100, outputTokens: 50, costUsd: 0.01 });
    b.charge("b", { ...ZERO_USAGE, inputTokens: 200, outputTokens: 20, costUsd: 0.02 });
    expect(b.spent.inputTokens).toBe(300);
    expect(b.spent.outputTokens).toBe(70);
    expect(b.remainingUsd).toBeCloseTo(0.97, 5);
  });
});
