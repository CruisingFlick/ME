import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class HaltedError extends Error {
  constructor(readonly reason: string) {
    super(`run halted: ${reason}`);
    this.name = "HaltedError";
  }
}

/**
 * One place to stop everything.
 *
 * Deliberately a file on disk rather than a process signal or an in-memory flag:
 * the run may be spread across child processes and a future restart, and a human
 * who wants it to stop should be able to do so with `touch .hive/HALT` from any
 * shell, without needing this process to be responsive.
 */
export class KillSwitch {
  private readonly file: string;
  private tripped: string | null = null;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, "HALT");
  }

  /** Throws HaltedError if anything has asked the run to stop. */
  assertLive(): void {
    const reason = this.reason();
    if (reason !== null) throw new HaltedError(reason);
  }

  reason(): string | null {
    if (this.tripped) return this.tripped;
    if (process.env.HIVE_HALT === "1") return "HIVE_HALT=1 in the environment";
    if (existsSync(this.file)) {
      const note = readFileSync(this.file, "utf8").trim();
      return note.length > 0 ? note : `halt file present at ${this.file}`;
    }
    return null;
  }

  get isLive(): boolean {
    return this.reason() === null;
  }

  /** Trip the switch from inside the process (e.g. budget blown). */
  trip(reason: string): void {
    this.tripped = reason;
    try {
      writeFileSync(this.file, reason);
    } catch {
      // the in-memory flag is still authoritative for this process
    }
  }

  /** Clear a previous halt so a new run can start. */
  reset(): void {
    this.tripped = null;
    try {
      rmSync(this.file, { force: true });
    } catch {
      // nothing to clear
    }
  }

  get path(): string {
    return this.file;
  }
}
