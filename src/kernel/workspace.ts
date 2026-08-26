import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { logger } from "../util/log.js";

const log = logger("workspace");

export interface MergeResult {
  merged: boolean;
  /** Files git could not reconcile, when merged is false. */
  conflicts: string[];
  detail: string;
}

export interface CommitResult {
  committed: boolean;
  sha?: string;
  filesChanged: number;
}

/**
 * Per-task git worktrees.
 *
 * Parallel builders sharing one directory is the fastest way for a swarm to
 * produce something none of them intended: agent A reads a file mid-write by
 * agent B, or two agents each "fix" the same import and the second silently
 * reverts the first. File-ownership rules reduce that; they do not remove it,
 * because an agent can always read - and be misled by - a file it does not own.
 *
 * A worktree gives each task a real checkout of its own. The integration branch
 * only ever advances through an explicit merge, so a collision surfaces as a
 * merge conflict - a thing the integrator can be handed - rather than as code
 * that looks fine and is wrong.
 */
export class Workspaces {
  readonly root: string;
  /** The integration checkout: where the architect, integrator and operator work. */
  readonly integration: string;
  private readonly worktreeRoot: string;
  private readonly created = new Set<string>();
  /**
   * Serialises every operation that touches the integration repository.
   *
   * Builders run in parallel by design, so without this two of them finishing
   * at the same moment would run `git merge` against the same branch
   * concurrently - or `git worktree add` against the same index. Git guards its
   * own index with a lock file and simply fails the loser, which would surface
   * as a random task failure under load and nowhere else.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    root: string,
    private readonly runId: string,
  ) {
    this.root = resolve(root);
    this.integration = join(this.root, "main");
    this.worktreeRoot = join(this.root, "tasks");
  }

  async init(): Promise<void> {
    mkdirSync(this.integration, { recursive: true });
    mkdirSync(this.worktreeRoot, { recursive: true });

    if (existsSync(join(this.integration, ".git"))) return;

    await this.git(this.integration, ["init", "--initial-branch=hive-main"]);
    // Identity is set on the repo rather than globally: the run must not depend
    // on, or alter, whatever git config the host happens to have.
    await this.git(this.integration, ["config", "user.name", "hive"]);
    await this.git(this.integration, ["config", "user.email", "hive@localhost"]);

    writeFileSync(
      join(this.integration, ".gitignore"),
      ["node_modules/", "dist/", ".env", "*.log", ".DS_Store", ""].join("\n"),
    );
    await this.git(this.integration, ["add", "-A"]);
    await this.git(this.integration, ["commit", "-m", `hive run ${this.runId}: base`]);
    log.info(`initialised integration checkout at ${this.integration}`);
  }

  /**
   * A checkout for one task, branched from the integration head *as it is now*.
   *
   * Branching at dispatch rather than at plan time is what lets a dependent task
   * see its predecessor's merged work without any explicit hand-off.
   */
  async forTask(taskId: string, options: { fresh?: boolean } = {}): Promise<string> {
    return this.serialise(() => this.createWorktree(taskId, options));
  }

  private async createWorktree(
    taskId: string,
    options: { fresh?: boolean },
  ): Promise<string> {
    const path = join(this.worktreeRoot, taskId);
    // An ordinary review round keeps the builder's work so it can address the
    // feedback. Only a failed merge asks for a fresh checkout, because there the
    // point is to redo the work on top of what has landed since.
    //
    // The on-disk check matters for a resumed run: this process did not create
    // the worktree, but the interrupted work in it is exactly what resuming is
    // meant to recover.
    if (!options.fresh && (this.created.has(taskId) || existsSync(path))) {
      this.created.add(taskId);
      return path;
    }

    const branch = this.branchFor(taskId);
    await this.git(this.integration, ["worktree", "remove", "--force", path]);
    await this.git(this.integration, ["branch", "-D", branch]);
    await this.git(this.integration, ["worktree", "add", "-b", branch, path, "HEAD"]);

    this.created.add(taskId);
    log.debug(`worktree for ${taskId} at ${path}`);
    return path;
  }

  /**
   * Commit whatever the builder left behind, and report whether the task has
   * produced anything at all.
   *
   * The question that matters is whether this task's branch differs from the
   * integration branch - not whether this particular round added something new.
   * Those are different, and conflating them breaks every retry: a builder
   * whose work was already committed on an earlier attempt correctly finds
   * nothing left to do, and would be told it changed nothing and sent back,
   * round after round, until the task was abandoned with its work sitting
   * finished on its own branch.
   */
  async commitTask(taskId: string, message: string): Promise<CommitResult> {
    const path = join(this.worktreeRoot, taskId);
    if (!existsSync(path)) return { committed: false, filesChanged: 0 };

    await this.git(path, ["add", "-A"]);
    const status = await this.git(path, ["status", "--porcelain"]);
    if (status.stdout.split("\n").filter(Boolean).length > 0) {
      await this.git(path, ["commit", "-m", message]);
    }

    // What does this branch hold relative to what has already landed?
    const changed = await this.git(path, ["diff", "--name-only", "hive-main...HEAD"]);
    const filesChanged = changed.stdout.split("\n").filter(Boolean).length;
    if (filesChanged === 0) return { committed: false, filesChanged: 0 };

    const head = await this.git(path, ["rev-parse", "HEAD"]);
    return { committed: true, sha: head.stdout.trim(), filesChanged };
  }

  /** The task's changes against the integration head, for the reviewer. */
  async diffTask(taskId: string, maxChars = 60_000): Promise<string> {
    const path = join(this.worktreeRoot, taskId);
    if (!existsSync(path)) return "(no worktree for this task)";

    // Include what is committed and what is merely staged, so a reviewer sees
    // the same thing whether or not the builder's work was committed yet.
    const committed = await this.git(path, ["diff", "hive-main...HEAD"]);
    const pending = await this.git(path, ["diff", "HEAD"]);
    const combined = [committed.stdout, pending.stdout].filter((s) => s.trim()).join("\n");
    if (!combined.trim()) return "(this task changed nothing)";
    return combined.length > maxChars
      ? `${combined.slice(0, maxChars)}\n... [diff truncated at ${maxChars} chars]`
      : combined;
  }

  /** Fast-forward or merge an approved task into the integration branch. */
  async mergeTask(taskId: string): Promise<MergeResult> {
    return this.serialise(() => this.merge(taskId));
  }

  private async merge(taskId: string): Promise<MergeResult> {
    const branch = this.branchFor(taskId);
    const exists = await this.git(this.integration, ["rev-parse", "--verify", branch]);
    if (exists.code !== 0) {
      return { merged: false, conflicts: [], detail: `no branch for ${taskId}` };
    }

    const result = await this.git(this.integration, [
      "merge",
      "--no-ff",
      "-m",
      `hive: merge ${taskId}`,
      branch,
    ]);
    if (result.code === 0) {
      return { merged: true, conflicts: [], detail: "merged" };
    }

    const conflicted = await this.git(this.integration, ["diff", "--name-only", "--diff-filter=U"]);
    const conflicts = conflicted.stdout.split("\n").filter(Boolean);
    // Leaving the integration branch mid-merge would poison every later task,
    // so back it out and report instead.
    await this.git(this.integration, ["merge", "--abort"]);
    return {
      merged: false,
      conflicts,
      detail: `merge conflict in ${conflicts.length} file(s): ${conflicts.join(", ")}`,
    };
  }

  /** Drop an abandoned task's checkout without touching the integration branch. */
  async discardTask(taskId: string): Promise<void> {
    return this.serialise(async () => {
      const path = join(this.worktreeRoot, taskId);
      await this.git(this.integration, ["worktree", "remove", "--force", path]);
      this.created.delete(taskId);
    });
  }

  /** Every tracked file at the integration head, with its contents. */
  async filesAtHead(): Promise<Array<{ path: string; content: string }>> {
    const listed = await this.git(this.integration, ["ls-files"]);
    const paths = listed.stdout.split("\n").filter(Boolean);
    const files: Array<{ path: string; content: string }> = [];
    for (const path of paths) {
      const blob = await this.git(this.integration, ["show", `HEAD:${path}`]);
      if (blob.code === 0) files.push({ path, content: blob.stdout });
    }
    return files;
  }

  async fileCount(): Promise<number> {
    const result = await this.git(this.integration, ["ls-files"]);
    return result.stdout.split("\n").filter(Boolean).length;
  }

  async headSha(): Promise<string | null> {
    const result = await this.git(this.integration, ["rev-parse", "HEAD"]);
    return result.code === 0 ? result.stdout.trim() : null;
  }

  /** Release worktrees but keep the integration checkout for inspection. */
  async cleanup(): Promise<void> {
    for (const taskId of [...this.created]) await this.discardTask(taskId);
    await this.git(this.integration, ["worktree", "prune"]);
  }

  /** Run `work` after every previously queued repository operation. */
  private serialise<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    // Keep the chain alive even if this operation rejects, or one failure would
    // deadlock every later task behind it.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private branchFor(taskId: string): string {
    return `task/${taskId.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
  }

  private git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return new Promise((done) => {
      const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", (err) => done({ stdout, stderr: String(err), code: 127 }));
      child.on("close", (code) => done({ stdout, stderr, code: code ?? 1 }));
    });
  }
}
