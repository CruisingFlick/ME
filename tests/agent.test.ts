import { describe, expect, it } from "vitest";
import { Agent } from "../src/agents/agent.js";
import { Blackboard } from "../src/kernel/blackboard.js";
import { Budget } from "../src/kernel/budget.js";
import { MessageBus } from "../src/kernel/bus.js";
import { KillSwitch } from "../src/kernel/killswitch.js";
import { Ledger } from "../src/kernel/ledger.js";
import { PolicyEngine } from "../src/kernel/policy.js";
import { MemoryStore } from "../src/kernel/store/memory.js";
import { TaskGraph } from "../src/kernel/tasks.js";
import { buildIntegrations } from "../src/integrations/index.js";
import type { CompletionResult, ModelProvider } from "../src/providers/types.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolContext } from "../src/tools/types.js";
import { logger } from "../src/util/log.js";

const STATE = "/tmp/hive-test-agent";

/** A provider that answers however the test says, and counts how often it was asked. */
function scripted(reply: (turn: number) => Partial<CompletionResult>): ModelProvider & {
  calls: number;
} {
  const provider = {
    id: "scripted",
    defaultModel: "m",
    calls: 0,
    available: () => true,
    unavailableReason: () => null,
    verify: async () => "ok",
    async complete(): Promise<CompletionResult> {
      provider.calls++;
      return {
        text: "",
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0.001 },
        ...reply(provider.calls),
      } as CompletionResult;
    },
  };
  return provider as ModelProvider & { calls: number };
}

async function agent(provider: ModelProvider): Promise<Agent> {
  const store = new MemoryStore();
  await store.init();
  const ledger = new Ledger(store, "run_agent", STATE);
  const tasks = new TaskGraph(store, ledger, "run_agent");
  await tasks.load();
  const context: Omit<ToolContext, "agent" | "taskId" | "log"> = {
    runId: "run_agent",
    workspace: "/tmp",
    bus: new MessageBus(store, ledger, "run_agent"),
    board: new Blackboard(store, ledger, "run_agent"),
    tasks,
    ledger,
    policy: new PolicyEngine({ runGrants: new Set(), workspace: "/tmp" }),
    budget: new Budget({
      maxRunUsd: 10,
      maxAgentUsd: 10,
      maxTurnsPerTask: 6,
      maxWallClockMs: 60_000,
    }),
    kill: new KillSwitch(STATE),
    integrations: buildIntegrations(),
    log: logger("test"),
  };
  return new Agent(
    { id: "architect-1", role: "architect", provider: provider.id, model: "m", capabilities: [] },
    provider,
    new ToolRegistry(),
    context,
  );
}

describe("an agent that answers in prose instead of calling a tool", () => {
  it("is nudged once, not once per remaining turn", async () => {
    // What this cost: an architect said its piece, was nudged on every one of
    // the five remaining turns, and repeated itself identically each time. A
    // third of the run's spend bought the same plan that was already there
    // after the first reply.
    const provider = scripted(() => ({ text: '{"plan": "same answer every time"}' }));
    const outcome = await (await agent(provider)).run({
      instruction: "plan it",
      maxTurns: 6,
    });

    // One real answer, one nudge, one more answer - then take the prose.
    expect(provider.calls).toBe(2);
    expect(outcome.kind).toBe("text");
    expect(outcome.text).toContain("same answer every time");
  });

  it("keeps the agent's last prose as the answer", async () => {
    const provider = scripted((turn) => ({ text: `answer ${turn}` }));
    const outcome = await (await agent(provider)).run({ instruction: "go", maxTurns: 6 });

    expect(provider.calls).toBe(2);
    expect(outcome.text).toBe("answer 2");
  });

  it("still lets an agent that goes back to work carry on", async () => {
    // The nudge budget resets on progress: falling silent once early must not
    // cost an agent its remaining turns.
    const provider = scripted((turn) => {
      if (turn === 2) {
        return {
          text: "thinking out loud",
          toolCalls: [{ id: "c1", name: "list_files", input: { path: "." } }],
        };
      }
      return { text: `prose ${turn}` };
    });
    const outcome = await (await agent(provider)).run({ instruction: "go", maxTurns: 6 });

    // turn 1 prose -> nudge; turn 2 tool call (progress, nudge budget resets);
    // turn 3 prose -> nudge again; turn 4 prose -> give up and take it.
    expect(provider.calls).toBe(4);
    expect(outcome.text).toBe("prose 4");
  });
});
