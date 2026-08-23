import type { Role, Task, TaskStatus } from "../types.js";
import { id, nowIso } from "../util/id.js";
import type { Ledger } from "./ledger.js";
import type { Store } from "./store/index.js";

export interface NewTask {
  id?: string;
  title: string;
  brief: string;
  paths?: string[];
  dependsOn?: string[];
  role?: Role;
}

/**
 * The work graph.
 *
 * Dependencies are the swarm's only real synchronisation primitive: an agent
 * never waits on another agent, it waits on a task. That keeps the run from
 * deadlocking on a conversation nobody answers, and makes "who is blocked on
 * what" a property you can read off the graph rather than infer from a chat log.
 */
export class TaskGraph {
  private tasks = new Map<string, Task>();

  constructor(
    private readonly store: Store,
    private readonly ledger: Ledger,
    private readonly runId: string,
  ) {}

  async load(): Promise<void> {
    const existing = await this.store.listTasks(this.runId);
    this.tasks = new Map(existing.map((t) => [t.id, t]));
  }

  async add(spec: NewTask): Promise<Task> {
    const task: Task = {
      id: spec.id ?? id("task"),
      runId: this.runId,
      title: spec.title,
      brief: spec.brief,
      paths: spec.paths ?? [],
      dependsOn: spec.dependsOn ?? [],
      role: spec.role ?? "builder",
      status: "pending",
      reviewRounds: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.tasks.set(task.id, task);
    await this.store.putTask(task);
    await this.ledger.record("task.status", "orchestrator", {
      taskId: task.id,
      title: task.title,
      status: task.status,
      dependsOn: task.dependsOn,
    });
    return task;
  }

  async update(taskId: string, patch: Partial<Task>, actor = "orchestrator"): Promise<Task> {
    const task = this.get(taskId);
    const next: Task = { ...task, ...patch, updatedAt: nowIso() };
    this.tasks.set(taskId, next);
    await this.store.putTask(next);
    if (patch.status && patch.status !== task.status) {
      await this.ledger.record("task.status", actor, {
        taskId,
        from: task.status,
        to: patch.status,
        ...(patch.feedback ? { feedback: patch.feedback.slice(0, 500) } : {}),
      });
    }
    return next;
  }

  get(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`unknown task "${taskId}"`);
    return task;
  }

  has(taskId: string): boolean {
    return this.tasks.has(taskId);
  }

  all(): Task[] {
    return [...this.tasks.values()];
  }

  byStatus(...statuses: TaskStatus[]): Task[] {
    const wanted = new Set(statuses);
    return this.all().filter((t) => wanted.has(t.status));
  }

  /** Tasks whose dependencies are all done and which nobody is working on. */
  ready(): Task[] {
    return this.all().filter(
      (task) =>
        (task.status === "pending" || task.status === "changes_requested") &&
        task.dependsOn.every((dep) => this.tasks.get(dep)?.status === "done"),
    );
  }

  get isComplete(): boolean {
    return this.all().every((t) => t.status === "done" || t.status === "abandoned");
  }

  /**
   * Tasks that can never run because something they depend on failed or is
   * missing. Without this check a run with one abandoned task spins forever
   * with an empty ready set and nothing in flight.
   */
  stuck(): Task[] {
    return this.all().filter((task) => {
      if (task.status === "done" || task.status === "abandoned") return false;
      return task.dependsOn.some((dep) => {
        const upstream = this.tasks.get(dep);
        return !upstream || upstream.status === "abandoned";
      });
    });
  }

  /** Dependency cycles, reported as the ids involved. Empty when the graph is sane. */
  cycles(): string[][] {
    const found: string[][] = [];
    const state = new Map<string, "visiting" | "done">();
    const stack: string[] = [];

    const visit = (taskId: string): void => {
      const current = state.get(taskId);
      if (current === "done") return;
      if (current === "visiting") {
        found.push([...stack.slice(stack.indexOf(taskId)), taskId]);
        return;
      }
      state.set(taskId, "visiting");
      stack.push(taskId);
      for (const dep of this.tasks.get(taskId)?.dependsOn ?? []) {
        if (this.tasks.has(dep)) visit(dep);
      }
      stack.pop();
      state.set(taskId, "done");
    };

    for (const taskId of this.tasks.keys()) visit(taskId);
    return found;
  }

  /** Compact board of the whole graph, for injection into prompts. */
  render(): string {
    if (this.tasks.size === 0) return "(no tasks yet)";
    return this.all()
      .map((t) => {
        const deps = t.dependsOn.length > 0 ? ` after:[${t.dependsOn.join(",")}]` : "";
        const who = t.assignee ? ` @${t.assignee}` : "";
        return `- ${t.id} [${t.status}]${who}${deps} ${t.title}`;
      })
      .join("\n");
  }
}
