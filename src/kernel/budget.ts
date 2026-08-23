import { addUsage, ZERO_USAGE, type Usage } from "../types.js";

export interface BudgetLimits {
  /** Hard ceiling for the whole run, in USD. */
  maxRunUsd: number;
  /** Hard ceiling for any single agent, in USD. */
  maxAgentUsd: number;
  /** Hard ceiling on model round-trips per agent turn-loop. */
  maxTurnsPerTask: number;
  /** Wall-clock ceiling for the run. */
  maxWallClockMs: number;
}

export class BudgetExceededError extends Error {
  constructor(
    message: string,
    readonly scope: "run" | "agent" | "turns" | "clock",
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/**
 * The money and time guardrail.
 *
 * A swarm with no human in the loop will happily spend until something stops
 * it, so nothing may call a model without first asking `check()`, and every
 * response must be reported to `charge()`.
 */
export class Budget {
  private runUsage: Usage = { ...ZERO_USAGE };
  private perAgent = new Map<string, Usage>();
  private readonly startedAt = Date.now();

  constructor(readonly limits: BudgetLimits) {}

  /** Throws if the next call would be made past a limit. Call before spending. */
  check(agentId: string): void {
    const elapsed = Date.now() - this.startedAt;
    if (elapsed > this.limits.maxWallClockMs) {
      throw new BudgetExceededError(
        `run exceeded its wall-clock limit of ${Math.round(this.limits.maxWallClockMs / 60000)} min`,
        "clock",
      );
    }
    if (this.runUsage.costUsd >= this.limits.maxRunUsd) {
      throw new BudgetExceededError(
        `run spend $${money(this.runUsage.costUsd)} reached the cap of $${money(this.limits.maxRunUsd)}`,
        "run",
      );
    }
    const agent = this.perAgent.get(agentId) ?? ZERO_USAGE;
    if (agent.costUsd >= this.limits.maxAgentUsd) {
      throw new BudgetExceededError(
        `agent ${agentId} spend $${money(agent.costUsd)} reached its cap of $${money(this.limits.maxAgentUsd)}`,
        "agent",
      );
    }
  }

  charge(agentId: string, usage: Usage): void {
    this.runUsage = addUsage(this.runUsage, usage);
    this.perAgent.set(agentId, addUsage(this.perAgent.get(agentId) ?? ZERO_USAGE, usage));
  }

  get spent(): Usage {
    return { ...this.runUsage };
  }

  agentSpend(agentId: string): Usage {
    return { ...(this.perAgent.get(agentId) ?? ZERO_USAGE) };
  }

  get remainingUsd(): number {
    return Math.max(0, this.limits.maxRunUsd - this.runUsage.costUsd);
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /** A one-line summary suitable for the ledger and the final report. */
  summary(): string {
    return (
      `$${this.runUsage.costUsd.toFixed(4)} of $${money(this.limits.maxRunUsd)} | ` +
      `${this.runUsage.inputTokens.toLocaleString()} in / ` +
      `${this.runUsage.outputTokens.toLocaleString()} out | ` +
      `${Math.round(this.elapsedMs / 1000)}s`
    );
  }
}

/** Two decimals for ordinary amounts, more when the value would round to zero. */
function money(value: number): string {
  if (value === 0) return "0.00";
  return value < 0.01 ? value.toPrecision(2) : value.toFixed(2);
}
