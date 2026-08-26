import { beforeAll, describe, expect, it, vi } from "vitest";
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

describe("publishing a project to GitHub", () => {
  /**
   * Records every GitHub API call and answers them plausibly, so a test can
   * assert on the shape of the conversation rather than on a live repository.
   */
  function fakeGitHub(options: { branchExists?: boolean } = {}) {
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const fetchStub = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const href = String(url);
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ method, url: href, body });

      if (method === "GET" && href.endsWith("/git/ref/heads/feature")) {
        return options.branchExists
          ? json({ object: { sha: "branchhead" } })
          : new Response("Not Found", { status: 404 });
      }
      if (method === "GET" && href.includes("/git/ref/heads/")) return json({ object: { sha: "mainhead" } });
      if (method === "GET" && /\/repos\/[^/]+\/[^/]+$/.test(href)) return json({ default_branch: "main" });
      if (method === "POST" && href.endsWith("/git/blobs")) return json({ sha: `blob${calls.length}` });
      if (method === "POST" && href.endsWith("/git/trees")) return json({ sha: "tree1" });
      if (method === "POST" && href.endsWith("/git/commits")) return json({ sha: "commit1" });
      if (method === "POST" && href.endsWith("/git/refs")) return json({});
      if (method === "PATCH" && href.includes("/git/refs/heads/")) return json({});
      throw new Error(`unexpected call: ${method} ${href}`);
    };

    return { calls, fetchStub };
  }

  const files = [
    { path: "src/a.ts", content: "a" },
    { path: "src/b.ts", content: "b" },
    { path: "package.json", content: "{}" },
  ];

  async function github() {
    vi.resetModules();
    process.env.GITHUB_TOKEN = "t";
    process.env.GITHUB_REPO = "owner/repo";
    const { GitHub } = await import("../src/integrations/github.js");
    return new GitHub();
  }

  it("publishes a whole project as one commit, not one per file", async () => {
    // The failure this prevents: a 17-file project landed as 17 commits with
    // the same message, and every commit but the last was a tree that does not
    // build. Anything watching the branch saw a broken project, and a run that
    // died partway left one behind with nothing to say so.
    const { calls, fetchStub } = fakeGitHub();
    vi.stubGlobal("fetch", fetchStub);
    try {
      const result = await (await github()).pushTree(
        { owner: "owner", repo: "repo" },
        "feature",
        files,
        "land the project",
      );
      expect(result.commit).toBe("commit1");
    } finally {
      vi.unstubAllGlobals();
    }

    const commits = calls.filter((c) => c.method === "POST" && c.url.endsWith("/git/commits"));
    expect(commits).toHaveLength(1);
    expect(commits[0]?.body.message).toBe("land the project");

    // Every file is in that one commit's tree.
    const trees = calls.filter((c) => c.method === "POST" && c.url.endsWith("/git/trees"));
    expect(trees).toHaveLength(1);
    expect(trees[0]?.body.tree).toHaveLength(files.length);

    // And none of it went through the per-file contents API.
    expect(calls.filter((c) => c.url.includes("/contents/") && c.method === "PUT")).toHaveLength(0);
  });

  it("adds to a branch that already exists rather than replacing it", async () => {
    // A second push must not be parented on the default branch: that builds a
    // commit which silently drops every file the first push landed and this
    // one does not mention.
    const { calls, fetchStub } = fakeGitHub({ branchExists: true });
    vi.stubGlobal("fetch", fetchStub);
    try {
      await (await github()).pushTree({ owner: "owner", repo: "repo" }, "feature", files, "more work");
    } finally {
      vi.unstubAllGlobals();
    }

    const commit = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/commits"));
    expect(commit?.body.parents).toEqual(["branchhead"]);
  });

  it("sends a whole project through the tool in one commit", async () => {
    // The regression guard that matters: the defect was in the tool, which
    // looped over the paths calling the per-file contents API, not in
    // pushTree. A 17-file project became 17 commits with one message.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dir = "/tmp/hive-test-integration-workspace";
    mkdirSync(`${dir}/src`, { recursive: true });
    for (const file of files) writeFileSync(`${dir}/${file.path}`, file.content);

    const { calls, fetchStub } = fakeGitHub();
    vi.stubGlobal("fetch", fetchStub);
    let result;
    try {
      resetConfig();
      process.env.GITHUB_TOKEN = "t";
      process.env.GITHUB_REPO = "owner/repo";
      const ctx = await context();
      result = await githubPushTool.run(
        { branch: "feature", paths: files.map((f) => f.path), message: "land the project" },
        ctx,
      );
    } finally {
      vi.unstubAllGlobals();
      resetConfig();
    }

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain("one commit");
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/git/commits"))).toHaveLength(1);
    expect(calls.filter((c) => c.method === "PUT" && c.url.includes("/contents/"))).toHaveLength(0);
  });

  it("starts from the default branch when the branch is new", async () => {
    const { calls, fetchStub } = fakeGitHub({ branchExists: false });
    vi.stubGlobal("fetch", fetchStub);
    try {
      await (await github()).pushTree({ owner: "owner", repo: "repo" }, "feature", files, "first push");
    } finally {
      vi.unstubAllGlobals();
    }

    const commit = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/commits"));
    expect(commit?.body.parents).toEqual(["mainhead"]);
  });
});
