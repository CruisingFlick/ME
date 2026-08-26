import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Workspaces } from "../src/kernel/workspace.js";

const ROOT = "/tmp/hive-test-worktrees";

let ws: Workspaces;

beforeEach(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  ws = new Workspaces(ROOT, "run_test");
  await ws.init();
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const write = (dir: string, name: string, body: string) =>
  writeFileSync(join(dir, name), body);

describe("Workspaces", () => {
  it("creates an integration checkout that is a real git repository", async () => {
    expect(existsSync(join(ws.integration, ".git"))).toBe(true);
    expect(await ws.headSha()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("gives each task a checkout that the others cannot see", async () => {
    const a = await ws.forTask("t1");
    const b = await ws.forTask("t2");

    write(a, "a.txt", "from task one");
    write(b, "b.txt", "from task two");

    // The isolation that matters: neither builder can read the other's
    // half-finished work, so neither can be misled by it.
    expect(existsSync(join(a, "b.txt"))).toBe(false);
    expect(existsSync(join(b, "a.txt"))).toBe(false);
    expect(existsSync(join(ws.integration, "a.txt"))).toBe(false);
  });

  it("reports an empty checkout as nothing committed", async () => {
    await ws.forTask("t1");
    expect(await ws.commitTask("t1", "nothing")).toEqual({
      committed: false,
      filesChanged: 0,
    });
  });

  it("merges an approved task into the integration branch", async () => {
    const a = await ws.forTask("t1");
    write(a, "a.txt", "hello");

    const commit = await ws.commitTask("t1", "add a.txt");
    expect(commit.committed).toBe(true);
    expect(commit.filesChanged).toBe(1);

    const merge = await ws.mergeTask("t1");
    expect(merge.merged).toBe(true);
    expect(readFileSync(join(ws.integration, "a.txt"), "utf8")).toBe("hello");
  });

  it("shows the reviewer a diff of only that task's changes", async () => {
    const a = await ws.forTask("t1");
    write(a, "a.txt", "reviewed content");
    await ws.commitTask("t1", "add a.txt");

    const diff = await ws.diffTask("t1");
    expect(diff).toContain("a.txt");
    expect(diff).toContain("reviewed content");
  });

  it("branches a later task from work already merged", async () => {
    const a = await ws.forTask("t1");
    write(a, "shared.txt", "v1");
    await ws.commitTask("t1", "add shared.txt");
    await ws.mergeTask("t1");

    // The dependent task starts from the current head, so it sees its
    // predecessor's work without any explicit hand-off.
    const b = await ws.forTask("t2");
    expect(readFileSync(join(b, "shared.txt"), "utf8")).toBe("v1");
  });

  it("reports a collision as a conflict and leaves the branch clean", async () => {
    const a = await ws.forTask("t1");
    const b = await ws.forTask("t2");

    // Both tasks touch a file neither declared - the case file-ownership rules
    // cannot catch, and the reason worktrees exist.
    write(a, "shared.txt", "written by task one");
    write(b, "shared.txt", "written by task two");
    await ws.commitTask("t1", "t1 edits shared");
    await ws.commitTask("t2", "t2 edits shared");

    expect((await ws.mergeTask("t1")).merged).toBe(true);

    const second = await ws.mergeTask("t2");
    expect(second.merged).toBe(false);
    expect(second.conflicts).toContain("shared.txt");

    // Critical: a failed merge must not leave the integration branch stuck
    // mid-merge, or every later task inherits the mess.
    expect(readFileSync(join(ws.integration, "shared.txt"), "utf8")).toBe("written by task one");
    expect(await ws.headSha()).toMatch(/^[0-9a-f]{40}$/);
    const next = await ws.forTask("t3");
    expect(readFileSync(join(next, "shared.txt"), "utf8")).toBe("written by task one");
  });

  it("keeps a task's work across an ordinary review round", async () => {
    const first = await ws.forTask("t1");
    write(first, "a.txt", "draft");
    const again = await ws.forTask("t1");
    expect(again).toBe(first);
    expect(readFileSync(join(again, "a.txt"), "utf8")).toBe("draft");
  });

  it("rebuilds a task's checkout from the current head when asked", async () => {
    const other = await ws.forTask("t0");
    write(other, "landed.txt", "merged work");
    await ws.commitTask("t0", "land it");
    await ws.mergeTask("t0");

    const first = await ws.forTask("t1");
    write(first, "scratch.txt", "abandoned draft");

    const fresh = await ws.forTask("t1", { fresh: true });
    expect(existsSync(join(fresh, "scratch.txt"))).toBe(false);
    expect(readFileSync(join(fresh, "landed.txt"), "utf8")).toBe("merged work");
  });

  it("ignores build output so it never reaches a commit", async () => {
    const a = await ws.forTask("t1");
    write(a, "keep.txt", "source");
    const modules = join(a, "node_modules");
    mkdirSync(modules, { recursive: true });
    write(modules, "junk.js", "vendored");

    await ws.commitTask("t1", "add source");
    await ws.mergeTask("t1");
    expect(await ws.fileCount()).toBe(2); // .gitignore and keep.txt
  });
});

describe("a task whose work is already committed", () => {
  it("still reports its work when a later round adds nothing", async () => {
    // The exact failure this prevents: a builder's work was committed on an
    // earlier attempt, so a retry correctly finds nothing left to do. Judging
    // by uncommitted changes would call that "no changes" and send the task
    // back until it was abandoned - with the finished work on its own branch.
    const dir = await ws.forTask("t1");
    write(dir, "server.ts", "export const app = 1;\n");

    const first = await ws.commitTask("t1", "build the server");
    expect(first).toMatchObject({ committed: true, filesChanged: 1 });

    // A second round changes nothing: the work was already done and committed.
    const second = await ws.commitTask("t1", "build the server");
    expect(second.committed).toBe(true);
    expect(second.filesChanged).toBe(1);
  });

  it("still reports nothing when the task genuinely did nothing", async () => {
    await ws.forTask("t2");
    expect(await ws.commitTask("t2", "nothing")).toEqual({
      committed: false,
      filesChanged: 0,
    });
  });

  it("reports nothing when the work is identical to what already landed", async () => {
    const first = await ws.forTask("t1");
    write(first, "shared.ts", "export const x = 1;\n");
    await ws.commitTask("t1", "add shared");
    await ws.mergeTask("t1");

    // A later task that recreates a file byte-for-byte has added nothing.
    const second = await ws.forTask("t2");
    write(second, "shared.ts", "export const x = 1;\n");
    expect(await ws.commitTask("t2", "same content")).toMatchObject({
      committed: false,
      filesChanged: 0,
    });
  });
});

describe("resuming an interrupted run", () => {
  it("adopts a worktree left behind by a previous process", async () => {
    const first = await ws.forTask("t1");
    write(first, "in-progress.txt", "half-written work");

    // A fresh manager over the same directory is what a resumed run sees.
    const resumed = new Workspaces(ROOT, "run_test");
    await resumed.init();
    const recovered = await resumed.forTask("t1");

    expect(recovered).toBe(first);
    expect(readFileSync(join(recovered, "in-progress.txt"), "utf8")).toBe("half-written work");
  });

  it("still honours an explicit request for a fresh checkout", async () => {
    const first = await ws.forTask("t1");
    write(first, "in-progress.txt", "half-written work");

    const resumed = new Workspaces(ROOT, "run_test");
    await resumed.init();
    const rebuilt = await resumed.forTask("t1", { fresh: true });

    expect(existsSync(join(rebuilt, "in-progress.txt"))).toBe(false);
  });
});

describe("concurrent access to the shared repository", () => {
  it("creates many worktrees at once without git tripping over its own index", async () => {
    const ids = ["c1", "c2", "c3", "c4", "c5", "c6"];

    // Builders run in parallel by design, so this is the normal case, not an
    // edge case. Un-serialised, git fails the loser of an index.lock race.
    const paths = await Promise.all(ids.map((id) => ws.forTask(id)));

    expect(new Set(paths).size).toBe(ids.length);
    for (const path of paths) expect(existsSync(join(path, ".gitignore"))).toBe(true);
  });

  it("merges tasks that finish simultaneously without losing any of them", async () => {
    const ids = ["m1", "m2", "m3", "m4"];
    for (const id of ids) {
      const dir = await ws.forTask(id);
      write(dir, `${id}.txt`, `written by ${id}`);
      await ws.commitTask(id, `add ${id}`);
    }

    const merges = await Promise.all(ids.map((id) => ws.mergeTask(id)));

    expect(merges.every((m) => m.merged)).toBe(true);
    for (const id of ids) {
      expect(readFileSync(join(ws.integration, `${id}.txt`), "utf8")).toBe(`written by ${id}`);
    }
  });

  it("does not deadlock later work when one operation fails", async () => {
    // A merge of a branch that does not exist fails; the queue must survive it.
    const failed = await ws.mergeTask("never-existed");
    expect(failed.merged).toBe(false);

    const dir = await ws.forTask("after-failure");
    write(dir, "ok.txt", "still working");
    await ws.commitTask("after-failure", "add ok.txt");
    expect((await ws.mergeTask("after-failure")).merged).toBe(true);
  });
});
