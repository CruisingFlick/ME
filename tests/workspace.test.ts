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

describe("leftovers in the integration checkout", () => {
  // The failure this whole block exists for: an agent working in the
  // integration checkout wrote copies of two files and did not commit them.
  // Git then refused the *checkout* of the next merge rather than attempting
  // it - which reports no unmerged paths at all. That was read as "merge
  // conflict in 0 files", and four tasks were sent to be rebuilt against a
  // conflict that did not exist. `git merge task/t4` applied cleanly the
  // moment the leftovers were gone.
  it("merges a branch that untracked copies of its own files would have blocked", async () => {
    const dir = await ws.forTask("t1");
    write(dir, "server.ts", "export const app = 1;\n");
    await ws.commitTask("t1", "add the server");

    // The integrator's leftover: the same file, uncommitted, in the tree the
    // merge has to check out into.
    write(ws.integration, "server.ts", "export const app = 1;\n");

    const merge = await ws.mergeTask("t1");
    expect(merge.merged).toBe(true);
    expect(merge.conflicts).toEqual([]);
    expect(readFileSync(join(ws.integration, "server.ts"), "utf8")).toBe("export const app = 1;\n");
  });

  it("keeps loose work rather than discarding it to clear the way", async () => {
    const dir = await ws.forTask("t1");
    write(dir, "a.txt", "task work");
    await ws.commitTask("t1", "add a.txt");

    // Unrelated to the merge, and nobody's to throw away: an agent wrote it.
    write(ws.integration, "notes.md", "integrator scratch\n");

    expect((await ws.mergeTask("t1")).merged).toBe(true);
    expect(readFileSync(join(ws.integration, "notes.md"), "utf8")).toBe("integrator scratch\n");
    // Committed, not merely left on disk - so the next merge is not blocked by
    // it either, and a later task branching from head can see it.
    const next = await ws.forTask("t2");
    expect(readFileSync(join(next, "notes.md"), "utf8")).toBe("integrator scratch\n");
  });

  it("still reports a real disagreement over the same file as a conflict", async () => {
    const dir = await ws.forTask("t1");
    write(dir, "server.ts", "export const app = 1;\n");
    await ws.commitTask("t1", "add the server");

    // Settling the tree must not paper over a genuine collision: this leftover
    // says something different from the branch, so the integrator has to decide.
    write(ws.integration, "server.ts", "export const app = 2;\n");

    const merge = await ws.mergeTask("t1");
    expect(merge.merged).toBe(false);
    expect(merge.conflicts).toContain("server.ts");
    expect(merge.detail).toContain("server.ts");
  });

  it("names git's own reason when a merge is refused before it starts", async () => {
    const dir = await ws.forTask("t1");
    write(dir, "a.txt", "task work");
    await ws.commitTask("t1", "add a.txt");

    // A previous process died mid-merge. Nothing is loose, so there is nothing
    // to settle, and git refuses outright - with no unmerged paths to point at.
    const head = await ws.headSha();
    writeFileSync(join(ws.integration, ".git", "MERGE_HEAD"), `${head}\n`);

    const merge = await ws.mergeTask("t1");
    expect(merge.merged).toBe(false);
    expect(merge.conflicts).toEqual([]);
    // The old message here was "merge conflict in 0 files", which named the
    // wrong cause and cost four tasks.
    expect(merge.detail).not.toContain("conflict in 0");
    expect(merge.detail).toContain("merge refused");
    expect(merge.detail).toMatch(/MERGE_HEAD/);
  });
});

describe("a halted run's work", () => {
  it("is still there after cleanup and a resume", async () => {
    // The invariant this enforces: a halt leaves its in-flight tasks
    // recoverable. It did not. cleanup() removed the checkout, and the resume
    // then found no path on disk, deleted the task's branch and started it
    // again from HEAD - so every task that had committed work but had not been
    // merged lost all of it, while the resume told its builder the work was
    // still in its checkout.
    const dir = await ws.forTask("t2");
    write(dir, "greet.js", "export const greet = () => 'hi';\n");
    expect(await ws.commitTask("t2", "implement greet")).toMatchObject({
      committed: true,
      filesChanged: 1,
    });

    await ws.cleanup();

    const resumed = new Workspaces(ROOT, "run_test");
    await resumed.init();
    const recovered = await resumed.forTask("t2");

    expect(readFileSync(join(recovered, "greet.js"), "utf8")).toContain("greet");
    expect(await resumed.commitTask("t2", "nothing new")).toMatchObject({ committed: true });
  });

  it("is still discarded when a fresh checkout is asked for", async () => {
    // A failed merge asks for fresh precisely to redo the work on top of what
    // landed since, so there the branch must go.
    const dir = await ws.forTask("t3");
    write(dir, "draft.js", "half-finished\n");
    await ws.commitTask("t3", "draft");
    await ws.cleanup();

    const resumed = new Workspaces(ROOT, "run_test");
    await resumed.init();
    const rebuilt = await resumed.forTask("t3", { fresh: true });
    expect(existsSync(join(rebuilt, "draft.js"))).toBe(false);
  });
})
