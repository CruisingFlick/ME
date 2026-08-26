import { describe, expect, it, beforeEach } from "vitest";
import { Blackboard } from "../src/kernel/blackboard.js";
import { MessageBus } from "../src/kernel/bus.js";
import { Ledger } from "../src/kernel/ledger.js";
import { MemoryStore } from "../src/kernel/store/memory.js";
import { Budget } from "../src/kernel/budget.js";
import { KillSwitch } from "../src/kernel/killswitch.js";
import { PolicyEngine } from "../src/kernel/policy.js";
import { TaskGraph } from "../src/kernel/tasks.js";
import { addTaskTool } from "../src/tools/collab.js";
import { buildIntegrations } from "../src/integrations/index.js";
import type { ToolContext } from "../src/tools/types.js";
import { logger } from "../src/util/log.js";

const STATE_DIR = "/tmp/hive-test-state";

async function wire() {
  const store = new MemoryStore();
  await store.init();
  const ledger = new Ledger(store, "run_test", STATE_DIR);
  return {
    bus: new MessageBus(store, ledger, "run_test"),
    board: new Blackboard(store, ledger, "run_test"),
  };
}

describe("MessageBus", () => {
  let bus: MessageBus;
  beforeEach(async () => {
    bus = (await wire()).bus;
  });

  it("delivers a directly addressed message", async () => {
    await bus.send({ from: "architect-1", to: "builder-1", subject: "s", body: "b" });
    const inbox = await bus.inbox("builder-1", "builder");
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.subject).toBe("s");
  });

  it("fans a role-addressed message out to that role", async () => {
    await bus.send({ from: "architect-1", to: "builder", subject: "all builders", body: "b" });
    expect(await bus.inbox("builder-1", "builder")).toHaveLength(1);
    expect(await bus.inbox("builder-2", "builder")).toHaveLength(1);
    expect(await bus.inbox("reviewer-1", "reviewer")).toHaveLength(0);
  });

  it("never delivers a message back to its own sender", async () => {
    await bus.send({ from: "builder-1", to: "*", subject: "broadcast", body: "b" });
    expect(await bus.inbox("builder-1", "builder")).toHaveLength(0);
    expect(await bus.inbox("builder-2", "builder")).toHaveLength(1);
  });

  it("delivers each message once", async () => {
    await bus.send({ from: "a", to: "builder-1", subject: "s", body: "b" });
    const first = await bus.inbox("builder-1", "builder");
    await bus.markRead("builder-1", first);
    expect(await bus.inbox("builder-1", "builder")).toHaveLength(0);
  });

  it("keeps a reply in the same thread", async () => {
    const request = await bus.send({ from: "a", to: "b", subject: "q", body: "?" });
    await bus.send({
      from: "b",
      to: "a",
      subject: "re: q",
      body: "!",
      kind: "response",
      threadId: request.threadId,
    });
    expect(await bus.thread(request.threadId)).toHaveLength(2);
  });
});

describe("Blackboard", () => {
  it("versions an overwrite instead of losing the history", async () => {
    const { board } = await wire();
    const first = await board.put("api.contract", { v: 1 }, "architect-1");
    const second = await board.put("api.contract", { v: 2 }, "builder-1");
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect((await board.get("api.contract"))?.value).toEqual({ v: 2 });
  });

  it("renders every key for prompt injection", async () => {
    const { board } = await wire();
    await board.put("db.schema", "create table x()", "builder-1");
    await board.put("plan.stack", { runtime: "node" }, "architect-1");
    const rendered = await board.render();
    expect(rendered).toContain("db.schema");
    expect(rendered).toContain("plan.stack");
    expect(rendered).toContain("create table x()");
  });
});

describe("Blackboard secrecy", () => {
  it("names a credential entry without broadcasting its value", async () => {
    const { board } = await wire();
    await board.put(
      "infra.database",
      { connectionUri: "postgres://user:hunter2@db.example/neondb" },
      "operator-1",
    );
    await board.put("plan.stack", { runtime: "node" }, "architect-1");

    // The board is rendered into every agent's prompt on every turn, so a
    // password here would otherwise reach every model repeatedly.
    const rendered = await board.render();
    expect(rendered).toContain("infra.database");
    expect(rendered).not.toContain("hunter2");
    expect(rendered).toContain("plan.stack");
    expect(rendered).toContain("node");
  });

  it("still returns the full value to an agent that asks for it", async () => {
    const { board } = await wire();
    await board.put("infra.database", { connectionUri: "postgres://u:pw@h/db" }, "operator-1");
    const entry = await board.get("infra.database");
    expect(JSON.stringify(entry?.value)).toContain("pw");
  });
});

describe("add_task", () => {
  async function context(maxTasks: number): Promise<ToolContext> {
    const store = new MemoryStore();
    await store.init();
    const ledger = new Ledger(store, "run_add", STATE_DIR);
    const tasks = new TaskGraph(store, ledger, "run_add", maxTasks);
    await tasks.load();
    return {
      runId: "run_add",
      agent: {
        id: "integrator-1",
        role: "integrator",
        provider: "mock",
        model: "m",
        capabilities: ["task:manage"],
      },
      workspace: "/tmp",
      bus: new MessageBus(store, ledger, "run_add"),
      board: new Blackboard(store, ledger, "run_add"),
      tasks,
      ledger,
      policy: new PolicyEngine({ runGrants: new Set(["task:manage"]), workspace: "/tmp" }),
      budget: new Budget({
        maxRunUsd: 1,
        maxAgentUsd: 1,
        maxTurnsPerTask: 5,
        maxWallClockMs: 120_000,
      }),
      kill: new KillSwitch(STATE_DIR),
      integrations: buildIntegrations(),
      log: logger("test"),
    };
  }

  it("adds work the plan missed", async () => {
    const ctx = await context(4);
    const result = await addTaskTool.run(
      { title: "wire the router", brief: "the plan forgot it" },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(ctx.tasks.all()).toHaveLength(1);
  });

  it("refuses once the work graph is full, and says what to do instead", async () => {
    // add_task exists so an integrator can hand real discovered work to a
    // builder. Unbounded, it is also how a run stops converging: a graph that
    // grows every round ends as an exhausted budget naming no cause.
    const ctx = await context(1);
    await addTaskTool.run({ title: "first", brief: "b" }, ctx);

    const refused = await addTaskTool.run({ title: "second", brief: "b" }, ctx);
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("size limit");
    // The finding is not lost - the agent is told where to put it.
    expect(refused.content).toContain("summary");
    expect(ctx.tasks.all()).toHaveLength(1);
  });
});
