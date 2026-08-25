import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCliProvider } from "../src/providers/claude-cli.js";

const DIR = "/tmp/hive-fake-path";
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(DIR, { recursive: true, force: true });
});

function fakeBinary(name: string): void {
  mkdirSync(DIR, { recursive: true });
  const file = join(DIR, name);
  writeFileSync(file, "#!/bin/sh\necho fake\n");
  chmodSync(file, 0o755);
  // PATH is replaced, not prepended: this machine has a real claude on PATH and
  // the test would otherwise pass by finding that instead of the fixture.
  process.env.PATH = DIR;
}

describe("locating the claude CLI", () => {
  it("finds the binary under its plain name", () => {
    fakeBinary("claude");
    expect(new ClaudeCliProvider().available()).toBe(true);
  });

  it("reports itself missing when nothing is on PATH", () => {
    mkdirSync(DIR, { recursive: true });
    process.env.PATH = DIR;
    const provider = new ClaudeCliProvider();
    expect(provider.available()).toBe(false);
    expect(provider.unavailableReason()).toContain("not on PATH");
  });

  it("finds a PATHEXT-suffixed binary, as npm installs on Windows", () => {
    // The real bug this covers: an npm-installed CLI on Windows is claude.cmd,
    // so looking for the bare name reports it missing however correctly it was
    // installed. PATHEXT is consulted on every platform, so the lookup itself
    // is testable here rather than only on Windows.
    fakeBinary("claude.cmd");
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";

    const found = process.platform === "win32";
    expect(new ClaudeCliProvider().available()).toBe(found);
  });
});
