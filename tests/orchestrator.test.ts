import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { KillSwitch } from "../src/kernel/killswitch.js";
import { MemoryStore } from "../src/kernel/store/memory.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { MockProvider, call, reply } from "../src/providers/mock.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { CompletionRequest } from "../src/providers/types.js";
import { buildIntegrations } from "../src/integrations/index.js";

const STATE_DIR = "/tmp/hive-test-run-state";
const WORKSPACE = "/tmp/hive-test-run-workspace";

afterEach(() => {
  rmSync(STATE_DIR, { recursive: true, force: true });
  rmSync(WORKSPACE, { recursive: true, force: true });
});

const PLAN = {
  summary: "one task",
  stack: { runtime: "node" },
  integrations: [],
  tasks: [
    {
      id: "t1",
      title: "Write the entrypoint",
      brief: "Create index.js",
      paths: ["index.js"],
      dependsOn: [],
      role: "builder",
    },
  ],
};

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    HIVE_STATE_DIR: STATE_DIR,
    HIVE_WORKSPACE: WORKSPACE,
    HIVE_MAX_USD: "10",
    HIVE_MAX_AGENT_USD: "5",
    HIVE_MAX_REVIEW_ROUNDS: "2",
    HIVE_MAX_TURNS: "8",
    ...overrides,
  });
}

function fingerprint(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}

/**
 * A builder that actually writes a file.
 *
 * Since worktree isolation landed, a task that declares completion with an
 * empty diff is rejected, so a stub that only calls complete_task no longer
 * represents a builder that did its job.
 */
function defaultBuilder(request: CompletionRequest) {
  const used = (tool: string) =>
    request.messages.some((turn) =>
      turn.content.some((part) => part.type === "tool_call" && part.name === tool),
    );
  if (!used("write_file")) {
    // Vary the content with the brief, so a task coming back with review
    // feedback produces a real diff the way an actual builder would. Rewriting
    // byte-identical content is correctly treated as having done nothing.
    const brief = request.messages[0]?.content[0];
    const revision = brief?.type === "text" ? fingerprint(brief.text) : "0";
    return reply("writing", [
      call("write_file", {
        path: "index.js",
        content: `export const ok = true;\n// revision ${revision}\n`,
      }),
    ]);
  }
  if (!used("complete_task")) {
    return reply("finishing", [call("complete_task", { summary: "wrote index.js" })]);
  }
  return reply("done");
}

/** A scripted swarm: each role's behaviour is supplied by the test. */
function scripted(script: {
  builder?: (request: CompletionRequest, seen: number) => ReturnType<typeof reply>;
  reviewer?: (request: CompletionRequest, seen: number) => ReturnType<typeof reply>;
}) {
  const counts = { builder: 0, reviewer: 0 };
  const provider = new MockProvider((request) => {
    const used = (tool: string) =>
      request.messages.some((turn) =>
        turn.content.some((part) => part.type === "tool_call" && part.name === tool),
      );

    if (request.system.includes("ROLE: architect")) return reply(JSON.stringify(PLAN));

    if (request.system.includes("ROLE: builder")) {
      if (script.builder) return script.builder(request, counts.builder++);
      return defaultBuilder(request);
    }

    if (request.system.includes("ROLE: reviewer")) {
      if (script.reviewer) return script.reviewer(request, counts.reviewer++);
      return used("submit_review")
        ? reply("done")
        : reply("reviewed", [call("submit_review", { verdict: "approve", summary: "fine" })]);
    }

    // integrator and operator
    return used("complete_task")
      ? reply("done")
      : reply("finishing", [call("complete_task", { summary: "green" })]);
  });

  const registry = new ProviderRegistry(new Map([["mock", provider]]));
  return { provider, registry };
}

async function runWith(
  script: Parameters<typeof scripted>[0],
  overrides: Record<string, string> = {},
) {
  const { registry, provider } = scripted(script);
  const store = new MemoryStore();
  await store.init();
  const orchestrator = await Orchestrator.create({
    spec: "build a thing",
    provider: "mock",
    reviewProvider: "mock",
    config: config(overrides),
    providers: registry,
    store,
    integrations: buildIntegrations(),
    dryRun: true,
    parallelism: 2,
  });
  const report = await orchestrator.run();
  await orchestrator.close();
  return { report, provider };
}

describe("Orchestrator", () => {
  it("plans, builds, reviews and integrates a project", async () => {
    const { report } = await runWith({});

    expect(report.status).toBe("succeeded");
    expect(report.plan?.tasks).toHaveLength(1);
    expect(report.tasks[0]?.status).toBe("done");
    expect(report.phases.map((p) => p.phase)).toEqual(["plan", "execute", "integrate", "ship"]);
    expect(report.phases.every((p) => p.ok)).toBe(true);
  });

  it("sends a rejected task back to the builder with the reviewer's findings", async () => {
    let briefsSeen: string[] = [];
    const { report } = await runWith({
      builder: (request) => {
        // The opening turn is the brief; capture it to prove feedback arrives.
        const opening = request.messages[0]?.content[0];
        if (opening?.type === "text" && !briefsSeen.includes(opening.text)) {
          briefsSeen.push(opening.text);
        }
        return defaultBuilder(request);
      },
      reviewer: (_request, seen) =>
        seen === 0
          ? reply("changes", [
              call("submit_review", {
                verdict: "request_changes",
                summary: "index.js does not handle the empty input case",
              }),
            ])
          : reply("approved", [call("submit_review", { verdict: "approve", summary: "fixed" })]),
    });

    expect(report.status).toBe("succeeded");
    expect(report.tasks[0]?.status).toBe("done");
    expect(report.tasks[0]?.reviewRounds).toBe(1);
    expect(briefsSeen).toHaveLength(2);
    expect(briefsSeen[1]).toContain("does not handle the empty input case");
  });

  it("abandons a task when review will not converge, instead of looping forever", async () => {
    const { report } = await runWith({
      reviewer: () =>
        reply("changes", [
          call("submit_review", { verdict: "request_changes", summary: "still wrong" }),
        ]),
    });

    expect(report.tasks[0]?.status).toBe("abandoned");
    expect(report.tasks[0]?.feedback).toContain("did not converge");
    expect(report.status).toBe("failed");
  });

  it("treats a missing verdict as a request for changes rather than an approval", async () => {
    const { report } = await runWith({
      // A reviewer that talks but never renders a verdict must not pass work through.
      reviewer: () => reply("Looks broadly reasonable to me."),
    });

    expect(report.tasks[0]?.status).toBe("abandoned");
    expect(report.tasks[0]?.feedback).toContain("did not return a verdict");
  });

  it("abandons a task the builder reports as blocked", async () => {
    const { report } = await runWith({
      builder: () =>
        reply("cannot proceed", [
          call("block_task", { reason: "the schema on the blackboard contradicts the brief" }),
        ]),
    });

    expect(report.tasks[0]?.status).toBe("abandoned");
    expect(report.tasks[0]?.feedback).toContain("contradicts the brief");
    expect(report.status).toBe("failed");
  });

  it("stops the run when the kill switch is tripped mid-build", async () => {
    const kill = new KillSwitch(STATE_DIR);
    const { report } = await runWith({
      builder: () => {
        kill.trip("operator pulled the plug");
        return reply("working", [call("complete_task", { summary: "half done" })]);
      },
    });

    expect(["halted", "failed"]).toContain(report.status);
    expect(JSON.stringify(report)).toContain("operator pulled the plug");
    kill.reset();
  });

  it("stops spending once the run cap is reached", async () => {
    // Every mock call costs $0.001, so a $0.002 cap is exhausted almost at once.
    const { report } = await runWith({}, { HIVE_MAX_USD: "0.002", HIVE_MAX_AGENT_USD: "0.002" });

    expect(report.status).toBe("failed");
    expect(report.usage.costUsd).toBeLessThan(0.02);
    // The run must say it ran out of money, not blame the architect's JSON.
    expect(JSON.stringify(report.notes)).toMatch(/budget|cap/i);
  });

  it("records the run in an append-only ledger", async () => {
    const { report } = await runWith({});
    const { readFileSync } = await import("node:fs");
    const events = readFileSync(report.ledgerPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type: string });
    const types = new Set(events.map((e) => e.type));

    expect(types).toContain("run.started");
    expect(types).toContain("model.call");
    expect(types).toContain("task.status");
    expect(types).toContain("run.finished");
  });
});
