import { z } from "zod";
import { parseJsonLoose } from "../util/json.js";

const TaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  brief: z.string().min(1),
  paths: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  role: z.enum(["builder", "reviewer", "integrator", "operator"]).default("builder"),
});

export const PlanSchema = z.object({
  summary: z.string().default(""),
  stack: z.record(z.unknown()).default({}),
  integrations: z.array(z.string()).default([]),
  tasks: z.array(TaskSchema).min(1),
});

export type Plan = z.infer<typeof PlanSchema>;
export type PlannedTask = z.infer<typeof TaskSchema>;

export interface PlanProblem {
  kind: "unknown_dependency" | "self_dependency" | "duplicate_id" | "path_conflict";
  detail: string;
}

/** Parse the architect's reply, tolerating fences and stray prose around the JSON. */
export function parsePlan(raw: string): Plan {
  return PlanSchema.parse(parseJsonLoose(raw));
}

/**
 * Structural checks on a plan before any agent acts on it.
 *
 * A plan is the one artefact in the run that every later step trusts, and the
 * architect is a language model: it is cheaper to reject a malformed graph here
 * than to discover halfway through that two tasks each wait on the other.
 */
export function validatePlan(plan: Plan): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const ids = new Set<string>();

  for (const task of plan.tasks) {
    if (ids.has(task.id)) {
      problems.push({ kind: "duplicate_id", detail: `task id "${task.id}" appears more than once` });
    }
    ids.add(task.id);
    if (task.dependsOn.includes(task.id)) {
      problems.push({ kind: "self_dependency", detail: `task "${task.id}" depends on itself` });
    }
  }

  for (const task of plan.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        problems.push({
          kind: "unknown_dependency",
          detail: `task "${task.id}" depends on "${dep}", which is not in the plan`,
        });
      }
    }
  }

  // Two tasks that can run at the same time must not write the same file.
  const owners = new Map<string, string[]>();
  for (const task of plan.tasks) {
    for (const path of task.paths) {
      owners.set(path, [...(owners.get(path) ?? []), task.id]);
    }
  }
  for (const [path, claimants] of owners) {
    if (claimants.length > 1 && !anyOrdered(plan, claimants)) {
      problems.push({
        kind: "path_conflict",
        detail: `tasks ${claimants.join(", ")} all claim "${path}" and none depends on another`,
      });
    }
  }

  return problems;
}

/** True when every pair in the set is ordered by the dependency graph. */
function anyOrdered(plan: Plan, ids: string[]): boolean {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (byId.get(from)?.dependsOn ?? []).some((dep) => reaches(dep, to, seen));
  };
  for (const a of ids) {
    for (const b of ids) {
      if (a !== b && !reaches(a, b) && !reaches(b, a)) return false;
    }
  }
  return true;
}
