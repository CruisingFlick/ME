import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunLock, RunLockedError } from "../src/kernel/runlock.js";

const STATE = "/tmp/hive-test-runlock";
const RUN = "run_locked";
const lockFile = join(STATE, "state", RUN, "LOCK");

afterEach(() => rmSync(STATE, { recursive: true, force: true }));

function writeLock(pid: number): void {
  mkdirSync(join(STATE, "state", RUN), { recursive: true });
  writeFileSync(
    lockFile,
    JSON.stringify({ runId: RUN, pid, host: "elsewhere", startedAt: new Date().toISOString() }),
  );
}

describe("RunLock", () => {
  it("records the holding process when taken", () => {
    new RunLock(STATE, RUN).acquire();
    const held = JSON.parse(readFileSync(lockFile, "utf8")) as { pid: number };
    expect(held.pid).toBe(process.pid);
  });

  it("refuses a second process while the first is alive", () => {
    // The real failure: two processes claim the same task and spawn builders
    // into the same worktree, and the second commits nothing because the first
    // already committed the work.
    writeLock(process.pid === 1 ? 2 : 1); // a pid that is not ours but does exist

    expect(() => new RunLock(STATE, RUN).acquire()).toThrow(RunLockedError);
  });

  it("names the holder so the message is actionable", () => {
    writeLock(process.pid === 1 ? 2 : 1);
    try {
      new RunLock(STATE, RUN).acquire();
      expect.unreachable("should have refused");
    } catch (err) {
      expect((err as Error).message).toMatch(/already being worked by process/);
      expect((err as Error).message).toContain(RUN);
    }
  });

  it("takes over a lock whose process is gone", () => {
    // A run killed by a closed window leaves its lock behind; refusing forever
    // would make every interrupted run unrecoverable.
    writeLock(4_000_000); // far above any real pid

    expect(() => new RunLock(STATE, RUN).acquire()).not.toThrow();
    const held = JSON.parse(readFileSync(lockFile, "utf8")) as { pid: number };
    expect(held.pid).toBe(process.pid);
  });

  it("treats an unreadable lock as absent rather than blocking forever", () => {
    mkdirSync(join(STATE, "state", RUN), { recursive: true });
    writeFileSync(lockFile, "{ this is not json");

    expect(() => new RunLock(STATE, RUN).acquire()).not.toThrow();
  });

  it("releases only its own lock", () => {
    const lock = new RunLock(STATE, RUN);
    lock.acquire();
    // Another process has since taken over; releasing must not clear their lock.
    writeLock(4_000_001);
    lock.release();

    const still = JSON.parse(readFileSync(lockFile, "utf8")) as { pid: number };
    expect(still.pid).toBe(4_000_001);
  });

  it("allows the same run again once released", () => {
    const first = new RunLock(STATE, RUN);
    first.acquire();
    first.release();

    expect(() => new RunLock(STATE, RUN).acquire()).not.toThrow();
  });
});
