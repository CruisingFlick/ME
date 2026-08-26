import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Crash handling cannot be tested in-process: the point is what happens when
 * the process itself dies, so each case runs in a child and the ledger it left
 * behind is read afterwards.
 */
function crashIn(body: string): Array<{ type: string; data: Record<string, unknown> }> {
  dir = mkdtempSync(join(tmpdir(), "hive-crash-"));
  const script = `
    import { MemoryStore } from ${JSON.stringify(join(process.cwd(), "src/kernel/store/memory.ts"))};
    import { Ledger } from ${JSON.stringify(join(process.cwd(), "src/kernel/ledger.ts"))};
    import { recordCrashes } from ${JSON.stringify(join(process.cwd(), "src/kernel/crash.ts"))};
    const store = new MemoryStore();
    await store.init();
    const ledger = new Ledger(store, "run_crash", ${JSON.stringify(dir)});
    recordCrashes(ledger);
    ${body}
  `;
  // .mts, because the probe lives outside the project and would otherwise be
  // treated as CommonJS, where top-level await is a syntax error.
  const file = join(dir, "probe.mts");
  writeFileSync(file, script);
  try {
    execFileSync("npx", ["tsx", file], { encoding: "utf8", stdio: "pipe" });
  } catch (err) {
    // A crashing child is the point - but a child that failed to start is not.
    const stderr = String((err as { stderr?: Buffer }).stderr ?? "");
    if (/Cannot find|SyntaxError|ERR_MODULE/.test(stderr)) {
      throw new Error(`probe failed to start:\n${stderr.slice(0, 800)}`);
    }
  }
  const path = join(dir, "runs", "run_crash.jsonl");
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("a process that dies says why", () => {
  it("records an uncaught exception", () => {
    const events = crashIn(`setTimeout(() => { throw new Error("boom in a timer"); }, 10);`);
    const error = events.find((e) => e.type === "error");

    expect(error).toBeDefined();
    expect(error?.data.stage).toBe("uncaught");
    expect(String(error?.data.error)).toContain("boom in a timer");
  }, 60_000);

  it("records an unhandled rejection", () => {
    const events = crashIn(`Promise.reject(new Error("nobody caught this")); await new Promise(r => setTimeout(r, 200));`);
    const error = events.find((e) => e.type === "error");

    expect(error?.data.stage).toBe("unhandled_rejection");
    expect(String(error?.data.error)).toContain("nobody caught this");
  }, 60_000);

  it("records an exit that no handler explained", () => {
    // What a kill from outside, or an out-of-memory death, looks like.
    const events = crashIn(`process.exit(0);`);
    const finished = events.find((e) => e.type === "run.finished");

    expect(finished?.data.status).toBe("vanished");
    expect(String(finished?.data.note)).toContain("killed from outside");
  }, 60_000);
});
