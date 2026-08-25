import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { KillSwitch } from "../src/kernel/killswitch.js";
import { FileStore } from "../src/kernel/store/file.js";
import { buildIntegrations } from "../src/integrations/index.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { MockProvider, call, reply } from "../src/providers/mock.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { CompletionRequest } from "../src/providers/types.js";

const STATE = "/tmp/hive-test-resume-state";
const WORKSPACE = "/tmp/hive-test-resume-workspace";
const RUN_ID = "run_resumable";

afterEach(() => {
  rmSync(STATE, { recursive: true, force: true });
  rmSync(WORKSPACE, { recursive: true, force: true });
});

const PLAN = {
  summary: "two tasks",
  stack: {},
  integrations: [],
  tasks: [
    { id: "t1", title: "First", brief: "write a.js", paths: ["a.js"], dependsOn: [], role: "builder" },
    { id: "t2", title: "Second", brief: "write b.js", paths: ["b.js"], dependsOn: [], role: "builder" },
  ],
};

const config = () =>
  loadConfig({
    HIVE_STATE_DIR: STATE,
    HIVE_WORKSPACE: WORKSPACE,
    HIVE_MAX_REVIEW_ROUNDS: "3",
    HIVE_MAX_TURNS: "8",
  });

function used(request: CompletionRequest, tool: string): boolean {
  return request.messages.some((turn) =>
    turn.content.some((part) => part.type === "tool_call" && part.name === tool),
  );
}

/** A swarm whose builders can be made to stop partway through. */
function swarm(onBuild: (taskBrief: string) => "work" | "stop") {
  const provider = new MockProvider((request) => {
    if (request.system.includes("ROLE: architect")) return reply(JSON.stringify(PLAN));

    if (request.system.includes("ROLE: builder")) {
      const opening = request.messages[0]?.content[0];
      const brief = opening?.type === "text" ? opening.text : "";
      if (onBuild(brief) === "stop") return reply("thinking...");
      if (!used(request, "write_file")) {
        // The prompt's work-graph section names every task, so identify this
        // agent's own task from the assignment header, not from a filename.
        const path = brief.includes("Task t1:") ? "a.js" : "b.js";
        return reply("writing", [call("write_file", { path, content: `export default "${path}";\n` })]);
      }
      if (!used(request, "complete_task")) {
        return reply("done", [call("complete_task", { summary: "written" })]);
      }
      return reply("finished");
    }

    if (request.system.includes("ROLE: reviewer")) {
      return used(request, "submit_review")
        ? reply("done")
        : reply("ok", [call("submit_review", { verdict: "approve", summary: "fine" })]);
    }

    return used(request, "complete_task")
      ? reply("done")
      : reply("green", [call("complete_task", { summary: "integrated" })]);
  });
  return new ProviderRegistry(new Map([["mock", provider]]));
}

async function orchestrate(registry: ProviderRegistry, resume: boolean) {
  const store = new FileStore(STATE, RUN_ID);
  await store.init();
  const orchestrator = await Orchestrator.create({
    spec: "build two files",
    runId: RUN_ID,
    resume,
    provider: "mock",
    reviewProvider: "mock",
    config: config(),
    providers: registry,
    store,
    integrations: buildIntegrations(),
    dryRun: true,
    parallelism: 1,
  });
  const report = await orchestrator.run();
  await orchestrator.close();
  return report;
}

describe("resuming an interrupted run", () => {
  it("remembers the provider it was started with", async () => {
    // A resume that silently swaps to a different model is a different run -
    // and if that model has no credentials, it fails at once having discarded
    // nothing but the user's time.
    const first = await orchestrate(swarm(() => "work"), false);
    expect(first.status).toBe("succeeded");

    const store = new FileStore(STATE, RUN_ID);
    await store.init();
    const stored = await store.getBoard(RUN_ID, "run.config");

    expect((stored?.value as { provider?: string })?.provider).toBe("mock");
  });


  it("picks up where it stopped instead of starting over", async () => {
    const kill = new KillSwitch(STATE);

    // First attempt: t1 lands, then the run is halted while t2 is in flight.
    const interrupted = await orchestrate(
      swarm((brief) => {
        if (brief.includes("Task t2:")) {
          kill.trip("operator halted the run");
          return "stop";
        }
        return "work";
      }),
      false,
    );

    expect(interrupted.status).toBe("halted");
    const t1 = interrupted.tasks.find((t) => t.id === "t1");
    const t2 = interrupted.tasks.find((t) => t.id === "t2");
    expect(t1?.status).toBe("done");
    // The halt is a fact about the run, not a judgement on the task: t2 must
    // stay recoverable rather than being abandoned.
    expect(t2?.status).not.toBe("abandoned");

    kill.reset();

    // Second attempt: the same run id, resumed. It must not re-plan and must
    // not rebuild t1.
    const registry = swarm(() => "work");
    const provider = registry.get("mock") as MockProvider;
    const resumed = await orchestrate(registry, true);

    const plannedAgain = provider.seen.some((request) => request.system.includes("ROLE: architect"));
    expect(plannedAgain).toBe(false);

    expect(resumed.status).toBe("succeeded");
    expect(resumed.tasks.every((task) => task.status === "done")).toBe(true);

    const rebuilt = provider.seen.filter(
      (request) =>
        request.system.includes("ROLE: builder") &&
        JSON.stringify(request.messages[0]).includes("Task t1:"),
    );
    expect(rebuilt).toHaveLength(0);
  });
});
