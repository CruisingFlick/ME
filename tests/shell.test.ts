import { describe, expect, it } from "vitest";
import { Blackboard } from "../src/kernel/blackboard.js";
import { Budget } from "../src/kernel/budget.js";
import { MessageBus } from "../src/kernel/bus.js";
import { KillSwitch } from "../src/kernel/killswitch.js";
import { Ledger } from "../src/kernel/ledger.js";
import { PolicyEngine } from "../src/kernel/policy.js";
import { MemoryStore } from "../src/kernel/store/memory.js";
import { TaskGraph } from "../src/kernel/tasks.js";
import { buildIntegrations } from "../src/integrations/index.js";
import { runCommandTool } from "../src/tools/shell.js";
import type { ToolContext } from "../src/tools/types.js";
import { logger } from "../src/util/log.js";

const STATE = "/tmp/hive-test-shell";

async function context(): Promise<ToolContext> {
  const store = new MemoryStore();
  await store.init();
  const ledger = new Ledger(store, "run_shell", STATE);
  const tasks = new TaskGraph(store, ledger, "run_shell");
  await tasks.load();
  return {
    runId: "run_shell",
    agent: {
      id: "builder-1",
      role: "builder",
      provider: "mock",
      model: "m",
      capabilities: ["shell:exec"],
    },
    workspace: "/tmp",
    bus: new MessageBus(store, ledger, "run_shell"),
    board: new Blackboard(store, ledger, "run_shell"),
    tasks,
    ledger,
    policy: new PolicyEngine({ runGrants: new Set(["shell:exec"]), workspace: "/tmp" }),
    budget: new Budget({
      maxRunUsd: 1,
      maxAgentUsd: 1,
      maxTurnsPerTask: 5,
      maxWallClockMs: 120_000,
    }),
    kill: new KillSwitch(STATE),
    integrations: buildIntegrations(),
    log: logger("test"),
  };
}

describe("run_command", () => {
  it("returns the output of a command that exits", async () => {
    const result = await runCommandTool.run({ command: "echo hello-from-hive" }, await context());
    expect(result.content).toContain("hello-from-hive");
    expect(result.content).toContain("exit code: 0");
  });

  it("reports a non-zero exit as information rather than a tool failure", async () => {
    // A failing build is something the agent must read and fix, not an error
    // that aborts its turn.
    const result = await runCommandTool.run({ command: "exit 3" }, await context());
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("exit code: 3");
  });

  it("always returns from a command that never exits on its own", async () => {
    // The failure this prevents: a builder starts a dev server, the shell is
    // killed but an orphan holds the stdout pipe open, `close` never fires, and
    // the whole run hangs with no error and nothing in the ledger.
    const started = Date.now();
    const result = await runCommandTool.run(
      { command: "sleep 60", timeout_seconds: 2 },
      await context(),
    );
    const elapsed = Date.now() - started;

    expect(result.content).toContain("exit code: 124");
    expect(result.content).toMatch(/does not exit on its own/);
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);

  it("kills the whole tree, not just the shell it started", async () => {
    // The orphan is what holds the pipe open, so a surviving grandchild would
    // reproduce the hang even with the timeout in place.
    const started = Date.now();
    const result = await runCommandTool.run(
      { command: "sh -c 'sleep 60 & wait'", timeout_seconds: 2 },
      await context(),
    );

    expect(result.content).toContain("exit code: 124");
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
