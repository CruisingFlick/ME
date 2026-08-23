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
