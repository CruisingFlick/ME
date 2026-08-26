import { describe, expect, it } from "vitest";
import { parsePlan, validatePlan } from "../src/orchestrator/plan.js";

const base = {
  summary: "s",
  stack: { runtime: "node" },
  integrations: [],
  tasks: [
    { id: "t1", title: "A", brief: "b", paths: ["src/a.ts"], dependsOn: [], role: "builder" },
    { id: "t2", title: "B", brief: "b", paths: ["src/b.ts"], dependsOn: ["t1"], role: "builder" },
  ],
};

describe("parsePlan", () => {
  it("parses a bare JSON object", () => {
    expect(parsePlan(JSON.stringify(base)).tasks).toHaveLength(2);
  });

  it("recovers a plan wrapped in a code fence and prose", () => {
    const raw = `Here is the plan.\n\n\`\`\`json\n${JSON.stringify(base)}\n\`\`\`\n\nLet me know.`;
    expect(parsePlan(raw).tasks).toHaveLength(2);
  });

  it("rejects a plan with no tasks", () => {
    expect(() => parsePlan(JSON.stringify({ ...base, tasks: [] }))).toThrow();
  });
});

describe("validatePlan", () => {
  it("accepts a well-formed plan", () => {
    expect(validatePlan(parsePlan(JSON.stringify(base)))).toEqual([]);
  });

  it("catches a dependency on a task that does not exist", () => {
    const plan = parsePlan(
      JSON.stringify({
        ...base,
        tasks: [{ ...base.tasks[0], dependsOn: ["nope"] }],
      }),
    );
    expect(validatePlan(plan)).toContainEqual(
      expect.objectContaining({ kind: "unknown_dependency" }),
    );
  });

  it("catches a duplicate task id", () => {
    const plan = parsePlan(
      JSON.stringify({ ...base, tasks: [base.tasks[0], { ...base.tasks[1], id: "t1" }] }),
    );
    expect(validatePlan(plan)).toContainEqual(expect.objectContaining({ kind: "duplicate_id" }));
  });

  it("catches two concurrent tasks claiming the same file", () => {
    const plan = parsePlan(
      JSON.stringify({
        ...base,
        tasks: [
          { ...base.tasks[0], paths: ["src/shared.ts"] },
          { ...base.tasks[1], dependsOn: [], paths: ["src/shared.ts"] },
        ],
      }),
    );
    expect(validatePlan(plan)).toContainEqual(expect.objectContaining({ kind: "path_conflict" }));
  });

  it("allows two tasks to share a file when one depends on the other", () => {
    const plan = parsePlan(
      JSON.stringify({
        ...base,
        tasks: [
          { ...base.tasks[0], paths: ["src/shared.ts"] },
          { ...base.tasks[1], dependsOn: ["t1"], paths: ["src/shared.ts"] },
        ],
      }),
    );
    expect(validatePlan(plan)).toEqual([]);
  });
});

describe("the size of a plan", () => {
  const oversized = {
    ...base,
    tasks: Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`,
      title: "A",
      brief: "b",
      paths: [`src/${i}.ts`],
      dependsOn: [],
      role: "builder",
    })),
  };

  it("is not checked unless the run sets a ceiling", () => {
    expect(validatePlan(parsePlan(JSON.stringify(oversized)))).toEqual([]);
  });

  it("is rejected while the architect can still be told to cut it", () => {
    // Cheaper here than as an exhausted budget an hour later that names no
    // cause: the architect gets the problem back and re-plans.
    const problems = validatePlan(parsePlan(JSON.stringify(oversized)), { maxTasks: 4 });
    expect(problems.map((p) => p.kind)).toContain("too_many_tasks");
    expect(problems[0]?.detail).toContain("6 tasks");
    expect(problems[0]?.detail).toContain("allows 4");
  });

  it("accepts a plan that exactly fills the ceiling", () => {
    expect(validatePlan(parsePlan(JSON.stringify(oversized)), { maxTasks: 6 })).toEqual([]);
  });
});
