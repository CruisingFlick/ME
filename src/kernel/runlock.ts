import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { logger } from "../util/log.js";

const log = logger("runlock");

export class RunLockedError extends Error {
  constructor(readonly holder: LockRecord) {
    super(
      `run ${holder.runId} is already being worked by process ${holder.pid} on ${holder.host} ` +
        `(started ${holder.startedAt}). Stop that process, or wait for it to finish.`,
    );
    this.name = "RunLockedError";
  }
}

interface LockRecord {
  runId: string;
  pid: number;
  host: string;
  startedAt: string;
}

/**
 * One process per run.
 *
 * Nothing stopped two hive processes working the same run, and the failure is
 * quiet and destructive: both claim the same task, both spawn a builder into
 * the same worktree, and the second commits nothing because the first already
 * committed the work - so a task that succeeded is sent back for "no changes",
 * having cost twice the quota. Resuming an interrupted run makes starting a
 * second copy by accident easy, which is exactly when it hurts most.
 */
export class RunLock {
  private readonly file: string;
  private held = false;

  constructor(
    stateDir: string,
    private readonly runId: string,
  ) {
    const dir = join(stateDir, "state", runId);
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "LOCK");
  }

  /** Take the lock, or throw naming whoever holds it. */
  acquire(): void {
    const existing = this.read();
    if (existing && existing.pid !== process.pid && isAlive(existing.pid)) {
      throw new RunLockedError(existing);
    }
    if (existing && !isAlive(existing.pid)) {
      log.info(`taking over from process ${existing.pid}, which is no longer running`);
    }
    const record: LockRecord = {
      runId: this.runId,
      pid: process.pid,
      host: hostname(),
      startedAt: new Date().toISOString(),
    };
    writeFileSync(this.file, JSON.stringify(record, null, 2));
    this.held = true;
  }

  release(): void {
    if (!this.held) return;
    // Only ever remove our own lock: a stale read here would otherwise let a
    // finishing process clear the lock of one that has just taken over.
    const existing = this.read();
    if (existing?.pid === process.pid) rmSync(this.file, { force: true });
    this.held = false;
  }

  private read(): LockRecord | null {
    if (!existsSync(this.file)) return null;
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as LockRecord;
    } catch {
      return null; // an unreadable lock is treated as absent
    }
  }
}

/**
 * Is a process still running?
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. EPERM means it exists but belongs to someone else - still running.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
