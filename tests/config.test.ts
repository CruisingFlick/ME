import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Run a snippet in a child process with a controlled environment.
 *
 * Configuration precedence cannot be tested in-process: dotenv reads the file
 * once at import, and the module is already loaded by the time a test runs.
 */
function loadIn(env: Record<string, string>, dotenv: string): Record<string, string> {
  dir = mkdtempSync(join(tmpdir(), "hive-config-"));
  writeFileSync(join(dir, ".env"), dotenv);
  const script = `
    import { getConfig, sourceOf } from ${JSON.stringify(join(process.cwd(), "src/config.ts"))};
    const c = getConfig();
    process.stdout.write(JSON.stringify({
      token: c.GITHUB_TOKEN ?? null,
      repo: c.GITHUB_REPO ?? null,
      source: sourceOf("GITHUB_TOKEN"),
    }));
  `;
  const file = join(dir, "probe.ts");
  writeFileSync(file, script);
  const out = execFileSync("npx", ["tsx", file], {
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return JSON.parse(out) as Record<string, string>;
}

describe("configuration precedence", () => {
  it("lets .env win over a stale variable left in the environment", () => {
    // The failure this prevents: a forgotten export silently shadowing the .env
    // someone just edited, surfacing only as an authentication error later.
    const result = loadIn(
      { GITHUB_TOKEN: "stale-value-from-the-shell" },
      "GITHUB_TOKEN=value-from-dotenv\nGITHUB_REPO=owner/repo\n",
    );

    expect(result.token).toBe("value-from-dotenv");
    expect(result.source).toBe(".env");
  });

  it("uses the environment when .env does not set the key", () => {
    // Deployments inject real environment variables and ship no .env.
    const result = loadIn({ GITHUB_TOKEN: "from-the-environment" }, "GITHUB_REPO=owner/repo\n");

    expect(result.token).toBe("from-the-environment");
    expect(result.source).toBe("environment");
  });
});
