import { describe, expect, it, beforeEach } from "vitest";
import { Ledger } from "../src/kernel/ledger.js";
import { MemoryStore } from "../src/kernel/store/memory.js";
import { TaskGraph } from "../src/kernel/tasks.js";

const STATE_DIR = "/tmp/hive-test-state";

async function graph(): Promise<TaskGraph> {
  const store = new MemoryStore();
  await store.init();
  const ledger = new Ledger(store, "run_test", STATE_DIR);
  const tasks = new TaskGraph(store, ledger, "run_test");
  await tasks.load();
  return tasks;
}

describe("TaskGraph", () => {
  let tasks: TaskGraph;
  beforeEach(async () => {
    tasks = await graph();
  });

  it("treats a task with no dependencies as ready", async () => {
    await tasks.add({ id: "a", title: "A", brief: "" });
    expect(tasks.ready().map((t) => t.id)).toEqual(["a"]);
  });

  it("holds a dependent task until its dependency is done", async () => {
    await tasks.add({ id: "a", title: "A", brief: "" });
    await tasks.add({ id: "b", title: "B", brief: "", dependsOn: ["a"] });

    expect(tasks.ready().map((t) => t.id)).toEqual(["a"]);
    await tasks.update("a", { status: "done" });
    expect(tasks.ready().map((t) => t.id)).toEqual(["b"]);
  });

  it("returns a task to the ready set after changes are requested", async () => {
    await tasks.add({ id: "a", title: "A", brief: "" });
    await tasks.update("a", { status: "in_review" });
    expect(tasks.ready()).toHaveLength(0);
    await tasks.update("a", { status: "changes_requested", feedback: "fix it" });
    expect(tasks.ready().map((t) => t.id)).toEqual(["a"]);
  });

  it("detects a dependency cycle", async () => {
    await tasks.add({ id: "a", title: "A", brief: "", dependsOn: ["b"] });
    await tasks.add({ id: "b", title: "B", brief: "", dependsOn: ["a"] });
    const cycles = tasks.cycles();
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("reports a task stranded behind an abandoned dependency", async () => {
    await tasks.add({ id: "a", title: "A", brief: "" });
    await tasks.add({ id: "b", title: "B", brief: "", dependsOn: ["a"] });
    await tasks.update("a", { status: "abandoned" });

    expect(tasks.stuck().map((t) => t.id)).toEqual(["b"]);
    // The critical property: a stranded task is never ready, so the execute
    // loop cannot spin waiting for it.
    expect(tasks.ready()).toHaveLength(0);
  });

  it("is complete only when every task is done or abandoned", async () => {
    await tasks.add({ id: "a", title: "A", brief: "" });
    await tasks.add({ id: "b", title: "B", brief: "" });
    expect(tasks.isComplete).toBe(false);
    await tasks.update("a", { status: "done" });
    await tasks.update("b", { status: "abandoned" });
    expect(tasks.isComplete).toBe(true);
  });
});

describe("the size of the work graph", () => {
  async function capped(maxTasks: number): Promise<TaskGraph> {
    const store = new MemoryStore();
    await store.init();
    const ledger = new Ledger(store, "run_capped", STATE_DIR);
    const tasks = new TaskGraph(store, ledger, "run_capped", maxTasks);
    await tasks.load();
    return tasks;
  }

  it("is unbounded when no ceiling is set", async () => {
    const tasks = await graph();
    expect(tasks.headroom()).toBe(Infinity);
  });

  it("reports the room left under its ceiling", async () => {
    const tasks = await capped(3);
    expect(tasks.headroom()).toBe(3);
    await tasks.add({ id: "a", title: "A", brief: "" });
    await tasks.add({ id: "b", title: "B", brief: "" });
    expect(tasks.headroom()).toBe(1);
  });

  it("reports no room once the ceiling is reached", async () => {
    const tasks = await capped(1);
    await tasks.add({ id: "a", title: "A", brief: "" });
    expect(tasks.headroom()).toBe(0);
  });

  it("still knows it is full after a resume", async () => {
    // The ceiling has to survive a restart, or a resumed run starts growing
    // its graph again from wherever it was stopped.
    const store = new MemoryStore();
    await store.init();
    const ledger = new Ledger(store, "run_capped", STATE_DIR);
    const first = new TaskGraph(store, ledger, "run_capped", 2);
    await first.load();
    await first.add({ id: "a", title: "A", brief: "" });
    await first.add({ id: "b", title: "B", brief: "" });

    const resumed = new TaskGraph(store, ledger, "run_capped", 2);
    await resumed.load();
    expect(resumed.headroom()).toBe(0);
  });
});
