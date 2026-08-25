import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig, resetConfig } from "../src/config.js";
import { Blackboard } from "../src/kernel/blackboard.js";
import { Budget } from "../src/kernel/budget.js";
import { MessageBus } from "../src/kernel/bus.js";
import { KillSwitch } from "../src/kernel/killswitch.js";
import { Ledger } from "../src/kernel/ledger.js";
import { PolicyEngine } from "../src/kernel/policy.js";
import { MemoryStore } from "../src/kernel/store/memory.js";
import { TaskGraph } from "../src/kernel/tasks.js";
import { buildIntegrations, integrationStatus } from "../src/integrations/index.js";
import {
  githubPushTool,
  neonBranchTool,
  railwayDeployTool,
  resendNotifyTool,
} from "../src/tools/integrations.js";
import type { ToolContext } from "../src/tools/types.js";
import { logger } from "../src/util/log.js";

const STATE = "/tmp/hive-test-integration-state";

// These tests are about the unconfigured path, so the ambient environment must
// not decide the outcome.
beforeAll(() => {
  for (const name of [
    "GITHUB_TOKEN", "GITHUB_REPO", "NEON_API_KEY", "NEON_PROJECT_ID",
    "RAILWAY_TOKEN", "RAILWAY_PROJECT_ID", "CLERK_SECRET_KEY", "RESEND_API_KEY", "RESEND_FROM",
  ]) {
    delete process.env[name];
  }
  resetConfig();
});

async function context(): Promise<ToolContext> {
  resetConfig();
  const store = new MemoryStore();
  await store.init();
  const ledger = new Ledger(store, "run_1", STATE);
  const tasks = new TaskGraph(store, ledger, "run_1");
  await tasks.load();
  return {
    runId: "run_1",
    agent: {
      id: "operator-1",
      role: "operator",
      provider: "mock",
      model: "m",
      capabilities: ["github:write", "db:write", "deploy:production", "email:send"],
    },
    workspace: "/tmp/hive-test-integration-workspace",
    bus: new MessageBus(store, ledger, "run_1"),
    board: new Blackboard(store, ledger, "run_1"),
    tasks,
    ledger,
    policy: new PolicyEngine({
      runGrants: new Set(["github:write", "db:write", "deploy:production", "email:send"]),
      workspace: "/tmp/hive-test-integration-workspace",
    }),
    budget: new Budget({
      maxRunUsd: 1,
      maxAgentUsd: 1,
      maxTurnsPerTask: 5,
      maxWallClockMs: 60_000,
    }),
    kill: new KillSwitch(STATE),
    integrations: buildIntegrations(),
    log: logger("test"),
  };
}

describe("an unconfigured integration", () => {
  it("reports itself unavailable with the reason, in the run status", () => {
    resetConfig();
    const status = integrationStatus(buildIntegrations());
    // Every entry is either available or says exactly what is missing.
    for (const [name, state] of Object.entries(status)) {
      expect(state === "available" || state.includes("is not set"), `${name}: ${state}`).toBe(true);
    }
  });

  it.each([
    ["github", githubPushTool, { branch: "b", paths: ["a.txt"], message: "m" }],
    ["neon", neonBranchTool, { name: "run-branch" }],
    ["railway", railwayDeployTool, { service_id: "svc" }],
    ["resend", resendNotifyTool, { to: "a@b.c", subject: "s", text: "t" }],
  ])("refuses %s cleanly and tells the agent not to fabricate", async (_name, tool, input) => {
    const ctx = await context();
    // No credentials are set in the test environment.
    const result = await tool.run(input as Record<string, unknown>, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/not configured|is not set/i);
    // The wording matters: an agent that reads this must record the gap rather
    // than inventing a plausible deploy URL.
    expect(result.content).toContain("Do not fabricate");
  });

  it("never returns a signal that would end the turn as a success", async () => {
    const ctx = await context();
    const result = await neonBranchTool.run({ name: "x" }, ctx);
    expect(result.signal).toBeUndefined();
  });
});

describe("capability gating on integration tools", () => {
  it("names the capability each tool needs", () => {
    expect(githubPushTool.capability).toBe("github:write");
    expect(neonBranchTool.capability).toBe("db:write");
    // Deploying to production and sending mail are the two withheld by default.
    expect(railwayDeployTool.capability).toBe("deploy:production");
    expect(resendNotifyTool.capability).toBe("email:send");
  });

  it("withholds the irreversible capabilities from a default configuration", () => {
    resetConfig();
    const config = loadConfig({ HIVE_GRANTS: undefined });
    for (const capability of ["deploy:production", "email:send", "db:destructive", "auth:admin"]) {
      expect(config.grants.has(capability as never), capability).toBe(false);
    }
  });
});

describe("GitHub availability", () => {
  it("needs both a token and a repository to be usable", async () => {
    const { GitHub } = await import("../src/integrations/github.js");
    const github = new GitHub();

    // Neither is set in this test environment.
    expect(github.available()).toBe(false);
    expect(github.unavailableReason()).toContain("GITHUB_TOKEN");

    process.env.GITHUB_TOKEN = "ghp_test";
    resetConfig();
    // A token alone is not a usable integration: every operation needs a repo,
    // and reporting it available sends agents down a path where inventing a
    // repository name looks reasonable.
    expect(github.available()).toBe(false);
    expect(github.unavailableReason()).toContain("GITHUB_REPO");

    process.env.GITHUB_REPO = "owner/repo";
    resetConfig();
    expect(github.available()).toBe(true);
    expect(github.defaultRepo()).toEqual({ owner: "owner", repo: "repo" });

    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_REPO;
    resetConfig();
  });

  it("rejects a malformed repo slug rather than half-using it", async () => {
    const { GitHub } = await import("../src/integrations/github.js");
    process.env.GITHUB_TOKEN = "ghp_test";
    process.env.GITHUB_REPO = "not-a-slug";
    resetConfig();

    const github = new GitHub();
    expect(github.defaultRepo()).toBeNull();
    expect(github.available()).toBe(false);

    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_REPO;
    resetConfig();
  });
});
