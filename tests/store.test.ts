import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore } from "../src/kernel/store/file.js";
import { nowIso } from "../src/util/id.js";
import type { Task } from "../src/types.js";

const STATE = "/tmp/hive-test-filestore";

afterEach(() => rmSync(STATE, { recursive: true, force: true }));

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    runId: "run_1",
    title: `task ${id}`,
    brief: "do the thing",
    paths: [],
    dependsOn: [],
    role: "builder",
    status: "pending",
    reviewRounds: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...overrides,
  };
}

describe("FileStore", () => {
  it("survives the process that wrote it", async () => {
    const first = new FileStore(STATE, "run_1");
    await first.init();
    await first.putTask(task("t1", { status: "done" }));
    await first.putTask(task("t2", { status: "in_progress" }));
    await first.putBoard({
      runId: "run_1",
      key: "api.contract",
      value: { shape: "rest" },
      author: "architect-1",
      version: 1,
      updatedAt: nowIso(),
    });

    // A second store over the same directory is what a resumed run sees.
    const resumed = new FileStore(STATE, "run_1");
    await resumed.init();

    const tasks = await resumed.listTasks("run_1");
    expect(tasks.map((t) => t.status)).toEqual(["done", "in_progress"]);
    expect((await resumed.getBoard("run_1", "api.contract"))?.value).toEqual({ shape: "rest" });
  });

  it("keeps ledger events across a restart", async () => {
    const first = new FileStore(STATE, "run_1");
    await first.init();
    await first.appendEvent({
      id: "ev1",
      runId: "run_1",
      type: "run.started",
      actor: "orchestrator",
      at: nowIso(),
      data: { note: "first" },
    });

    const resumed = new FileStore(STATE, "run_1");
    await resumed.init();
    expect(await resumed.listEvents("run_1")).toHaveLength(1);
  });

  it("recovers from a torn final line rather than losing the whole log", async () => {
    const store = new FileStore(STATE, "run_1");
    await store.init();
    await store.appendEvent({
      id: "ev1",
      runId: "run_1",
      type: "run.started",
      actor: "orchestrator",
      at: nowIso(),
      data: {},
    });

    // Exactly what a kill mid-write leaves behind.
    const { appendFileSync } = await import("node:fs");
    appendFileSync(`${STATE}/state/run_1/events.jsonl`, '{"id":"ev2","runId":"run_1"');

    const resumed = new FileStore(STATE, "run_1");
    await resumed.init();
    expect(await resumed.listEvents("run_1")).toHaveLength(1);
  });

  it("keeps runs separate", async () => {
    const a = new FileStore(STATE, "run_a");
    const b = new FileStore(STATE, "run_b");
    await a.init();
    await b.init();
    await a.putTask(task("t1", { runId: "run_a" }));

    expect(await b.listTasks("run_b")).toHaveLength(0);
  });
});
