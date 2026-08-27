import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Agent, type AgentOutcome } from "../agents/agent.js";
import { needsStrongestModel } from "../agents/roles.js";
import { getConfig, type HiveConfig } from "../config.js";
import { Blackboard } from "../kernel/blackboard.js";
import { Budget } from "../kernel/budget.js";
import { MessageBus } from "../kernel/bus.js";
import { KillSwitch } from "../kernel/killswitch.js";
import { recordCrashes } from "../kernel/crash.js";
import { Ledger } from "../kernel/ledger.js";
import { PolicyEngine } from "../kernel/policy.js";
import { RunLock } from "../kernel/runlock.js";
import { openStore, type Store } from "../kernel/store/index.js";
import { Workspaces } from "../kernel/workspace.js";
import { TaskGraph } from "../kernel/tasks.js";
import { buildIntegrations, integrationStatus, type Integrations } from "../integrations/index.js";
import { ProviderRegistry, CLI_PROVIDER_IDS } from "../providers/registry.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import { ZERO_USAGE, type AgentSpec, type Role, type Task, type Usage } from "../types.js";
import { id } from "../util/id.js";
import { logger } from "../util/log.js";
import { parsePlan, validatePlan, type Plan } from "./plan.js";

const log = logger("orchestrator");

/** The integration branch at its base commit holds only the .gitignore. */
const BASE_TRACKED_FILES = 1;

type StopCause = "budget" | "provider" | "operator" | "failure";

const LEDGER_FOR_STOP = {
  budget: "budget.exceeded",
  provider: "error",
  operator: "killswitch.tripped",
  failure: "error",
} as const;

/**
 * Why a run stopped, from the message that stopped it.
 *
 * The same cause has to reach the same terminal state wherever it happens: an
 * exhausted budget used to report "failed" when it landed during planning and
 * "halted" when it landed during execution, which made the report's status a
 * fact about timing rather than about the run.
 *
 * Order matters - a budget trip goes through the kill switch, so its message
 * says "run halted" too, and the more specific cause has to be read first.
 */
function stopCause(message: string): StopCause {
  if (/spend or time cap|budget|wall clock/i.test(message)) return "budget";
  if (/model provider failed|quota|provider error/i.test(message)) return "provider";
  if (message.startsWith("run halted") || message.includes("(halted)")) return "operator";
  return "failure";
}


export interface RunOptions {
  /** The project specification, in prose. */
  spec: string;
  runId?: string;
  /** Provider that builds. Defaults to anthropic. */
  provider?: string;
  model?: string;
  /** Provider that reviews. Defaults to a different vendor than the builder. */
  reviewProvider?: string;
  reviewModel?: string;
  workspace?: string;
  /** Plan, build, review and integrate, but do not touch any external service. */
  dryRun?: boolean;
  parallelism?: number;
  /** Continue an interrupted run instead of starting a new one. */
  resume?: boolean;
  /** Put abandoned tasks back in the queue; use when the cause was not the task. */
  retryAbandoned?: boolean;
  config?: HiveConfig;
  providers?: ProviderRegistry;
  store?: Store;
  integrations?: Integrations;
}

export interface RunReport {
  runId: string;
  status: "succeeded" | "failed" | "halted";
  workspace: string;
  /** Head of the integration branch when the run ended, if anything was merged. */
  head: string | null;
  filesTracked: number;
  /** Where the work was published, when publishing was possible. */
  published?: { branch: string; commit: string; pullRequest?: string };
  plan?: Plan;
  tasks: Task[];
  usage: Usage;
  spendSummary: string;
  ledgerPath: string;
  /** Phases that ran, in order, with their outcome. */
  phases: Array<{ phase: string; ok: boolean; detail: string }>;
  notes: string[];
}

interface Wiring {
  ledger: Ledger;
  bus: MessageBus;
  board: Blackboard;
  tasks: TaskGraph;
  policy: PolicyEngine;
  budget: Budget;
  kill: KillSwitch;
  integrations: Integrations;
  tools: ToolRegistry;
  providers: ProviderRegistry;
  workspaces: Workspaces;
  lock: RunLock;
}

/**
 * The conductor.
 *
 * Deliberately ordinary code rather than another model: the sequencing of a
 * build - what may start, what must wait, when to stop trying - is exactly the
 * part that must be predictable. An LLM orchestrating LLMs compounds their
 * variance; a fixed pipeline with model-driven steps inside it does not.
 */
export class Orchestrator {
  private constructor(
    readonly runId: string,
    private readonly options: RunOptions,
    private readonly config: HiveConfig,
    private readonly workspace: string,
    private readonly store: Store,
    private readonly w: Wiring,
  ) {}

  static async create(options: RunOptions): Promise<Orchestrator> {
    const config = options.config ?? getConfig();
    const runId = options.runId ?? id("run");
    const workspaceRoot = resolve(options.workspace ?? config.HIVE_WORKSPACE, runId);
    mkdirSync(workspaceRoot, { recursive: true });

    // Every task gets its own checkout; the integration branch is what the
    // architect, integrator and operator see.
    const workspaces = new Workspaces(workspaceRoot, runId);
    await workspaces.init();
    const workspace = workspaces.integration;

    const store = options.store ?? (await openStore(runId));
    const ledger = new Ledger(store, runId, config.HIVE_STATE_DIR);
    const tasks = new TaskGraph(store, ledger, runId, config.HIVE_MAX_TASKS);
    await tasks.load();

    const w: Wiring = {
      ledger,
      tasks,
      bus: new MessageBus(store, ledger, runId),
      board: new Blackboard(store, ledger, runId),
      workspaces,
      lock: new RunLock(config.HIVE_STATE_DIR, runId),
      policy: new PolicyEngine({ runGrants: config.grants, workspace }),
      budget: new Budget({
        maxRunUsd: config.HIVE_MAX_USD,
        maxAgentUsd: config.HIVE_MAX_AGENT_USD,
        maxTurnsPerTask: config.HIVE_MAX_TURNS,
        maxWallClockMs: config.HIVE_WALL_CLOCK_MINUTES * 60_000,
      }),
      kill: new KillSwitch(config.HIVE_STATE_DIR),
      integrations: options.integrations ?? buildIntegrations(),
      tools: new ToolRegistry(),
      providers: options.providers ?? new ProviderRegistry(),
    };

    return new Orchestrator(runId, options, config, workspace, store, w);
  }

  /**
   * Return abandoned tasks to the queue when asked.
   *
   * Abandonment is terminal by design - it is how a run stops paying for work
   * that will not converge. But a task abandoned because the provider could not
   * authenticate was never judged at all, and without this the only way to
   * retry it is to discard every task that did succeed.
   */
  private async reviveAbandoned(): Promise<void> {
    if (!this.options.retryAbandoned) return;
    for (const task of this.w.tasks.byStatus("abandoned")) {
      await this.w.tasks.update(task.id, {
        status: "pending",
        reviewRounds: 0,
        feedback: undefined,
      });
      log.info(`revived abandoned task ${task.id}`);
    }
  }

  /** Restore the provider choices a resumed run was originally started with. */
  private async restoreConfig(): Promise<void> {
    if (!this.options.resume) return;
    const stored = await this.w.board.get("run.config");
    if (!stored) return;
    const config = stored.value as Partial<Record<string, string>>;
    // An explicit flag still wins; this only fills in what was not given.
    this.options.provider ??= config.provider;
    this.options.model ??= config.model;
    this.options.reviewProvider ??= config.reviewProvider;
    this.options.reviewModel ??= config.reviewModel;
    log.info(`resuming with provider ${this.options.provider ?? "(default)"}`);
  }

  async run(): Promise<RunReport> {
    const phases: RunReport["phases"] = [];
    const notes: string[] = [];
    let plan: Plan | undefined;
    let published: RunReport["published"];
    let status: RunReport["status"] = "succeeded";

    // Before anything else: no second process on this run. Two of them claim the
    // same task and spawn builders into the same worktree.
    this.w.lock.acquire();

    // From here on, however this process ends, it says so in the ledger.
    const stopRecordingCrashes = recordCrashes(this.w.ledger);

    // A halt left over from a previous run would stop this one before it starts.
    // Resuming is itself an instruction to continue, so the halt clears either way.
    this.w.kill.reset();
    await this.restoreConfig();
    await this.reviveAbandoned();

    await this.w.ledger.record("run.started", "orchestrator", {
      workspace: this.workspace,
      builder: this.builderProvider,
      reviewer: this.reviewerProvider,
      dryRun: this.options.dryRun ?? false,
      grants: [...this.config.grants],
      integrations: integrationStatus(this.w.integrations),
    });
    log.info(`run ${this.runId} starting in ${this.workspace}`);

    try {
      if (this.builderProvider !== this.reviewerProvider) {
        notes.push(
          `cross-vendor review: built by ${this.builderProvider}, reviewed by ${this.reviewerProvider}`,
        );
      } else {
        notes.push(
          `single-vendor run: ${this.builderProvider} both builds and reviews - configure a second provider for independent review`,
        );
      }

      const onCli = [this.builderProvider, this.reviewerProvider].filter((id) =>
        CLI_PROVIDER_IDS.has(id),
      );
      if (onCli.length > 0) {
        notes.push(
          `spend shown is what these tokens would cost through the API; ` +
            `${[...new Set(onCli)].join(" and ")} runs on the installed CLI, so a subscription ` +
            `is charged nothing per run and its own session allowance is the real limit`,
        );
      }

      const worker = this.modelFor("builder", this.builderProvider, this.builderModel);
      if (worker !== this.builderModel) {
        notes.push(
          `models: ${this.builderModel} for planning and review, ${worker} for building`,
        );
      }

      plan = await this.plan();
      phases.push({ phase: "plan", ok: true, detail: `${plan.tasks.length} tasks` });

      const built = await this.execute();
      phases.push({
        phase: "execute",
        ok: built.failed === 0,
        detail: `${built.done} done, ${built.failed} not completed`,
      });
      // A task that did not complete is not on its own a failed run. Closing
      // the gaps its builders left is the integrator's whole job, and whether
      // the run delivered is a question about the integration branch, not
      // about the bookkeeping - see below.
      if (built.failed > 0) {
        notes.push(
          `${built.failed} task(s) did not complete; the integrator was asked to close the gap`,
        );
      }

      const integrated = await this.runSingle("integrator", this.integrationBrief());
      phases.push({ phase: "integrate", ok: integrated.ok, detail: integrated.detail });

      // Whether the run delivered is a question about the integration branch,
      // not about the task bookkeeping and not about an agent's own account of
      // itself. Closing the gaps its builders left is the integrator's whole
      // job, so tasks that did not complete do not condemn the run - but an
      // integrator that reports success over an empty branch does, which is
      // the same standard a task with an empty diff is held to.
      //
      // An empty branch is not damning on its own - a run whose every task
      // legitimately needed no changes has nothing to show and is still a
      // success. It is damning when work went missing: tasks that did not
      // complete and nothing on the branch to stand in for them.
      const tracked = await this.w.workspaces.fileCount();
      const delivered =
        integrated.ok && (tracked > BASE_TRACKED_FILES || built.failed === 0);
      if (!delivered) status = "failed";
      if (integrated.ok && !delivered) {
        notes.push(
          `${built.failed} task(s) did not complete and the integration branch is empty: ` +
            `nothing was produced for them`,
        );
      }

      // Publishing preserves the work; it is not a reward for a tidy run.
      // Gating it on the task bookkeeping threw away a finished project: two
      // builders never landed a diff, the integrator implemented greet() and
      // its tests itself, `npm test` passed 2 of 2 - and because the run had
      // already latched "failed", none of it was ever pushed and the report
      // said the build had not reached green when it plainly had.
      if (!this.options.dryRun && delivered) {
        const outcome = await this.publish();
        phases.push({ phase: "publish", ok: outcome.ok, detail: outcome.detail });
        published = outcome.result;
        if (!outcome.ok) status = "failed";
      }

      if (this.options.dryRun) {
        phases.push({ phase: "ship", ok: true, detail: "skipped (dry run)" });
        notes.push("dry run: no external service was contacted");
      } else if (status === "failed") {
        const reason = delivered
          ? "skipped (the build was not published)"
          : "skipped (the build did not reach green)";
        phases.push({ phase: "ship", ok: false, detail: reason });
        notes.push(`ship was ${reason}`);
      } else {
        const shipped = await this.runSingle("operator", this.shipBrief(published));
        phases.push({ phase: "ship", ok: shipped.ok, detail: shipped.detail });
        if (!shipped.ok) status = "failed";
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const cause = stopCause(message);
      // Stopping at a guardrail is not the same as failing. A cap reached, a
      // provider out of quota and an operator pulling the plug all leave the
      // work recoverable, so all three report as halted - but each says which
      // it was, because a ledger that calls a quota exhaustion a kill switch
      // describes an operator decision that nobody made.
      status = cause === "failure" ? "failed" : "halted";
      phases.push({ phase: "run", ok: false, detail: message });
      notes.push(message);
      await this.w.ledger.record(LEDGER_FOR_STOP[cause], "orchestrator", { error: message, cause });
      log.error(cause === "failure" ? "run failed" : `run stopped (${cause})`, message);
    }

    // Only release the worktrees when there is nothing left to come back for.
    // A halted or failed run is precisely the one that gets resumed, and
    // removing the checkouts takes with them whatever a builder had written
    // but not yet committed - while promising, on the way back in, that the
    // work is still there.
    if (status === "succeeded") await this.w.workspaces.cleanup();

    const report: RunReport = {
      runId: this.runId,
      status,
      workspace: this.workspace,
      head: await this.w.workspaces.headSha(),
      filesTracked: await this.w.workspaces.fileCount(),
      published,
      plan,
      tasks: this.w.tasks.all(),
      usage: this.w.budget.spent ?? { ...ZERO_USAGE },
      spendSummary: this.w.budget.summary(),
      ledgerPath: this.w.ledger.path,
      phases,
      notes,
    };

    await this.w.ledger.record("run.finished", "orchestrator", {
      status,
      spend: report.spendSummary,
      phases,
    });
    stopRecordingCrashes();
    await this.w.board.put("run.report", report, "orchestrator");
    log.info(`run ${this.runId} ${status} - ${report.spendSummary}`);
    return report;
  }

  /**
   * Run only the planning phase and return the validated plan.
   *
   * Iterating on a specification is much cheaper than discovering at the end of
   * a build that the spec was ambiguous, so planning is worth being able to do
   * on its own.
   */
  async planOnly(): Promise<Plan> {
    this.w.lock.acquire();
    this.w.kill.reset();
    await this.w.ledger.record("run.started", "orchestrator", { mode: "plan-only" });
    const plan = await this.plan();
    await this.w.ledger.record("run.finished", "orchestrator", {
      status: "succeeded",
      spend: this.w.budget.summary(),
    });
    return plan;
  }

  get spendSummary(): string {
    return this.w.budget.summary();
  }

  async close(): Promise<void> {
    this.w.lock.release();
    if (!this.options.store) await this.store.close();
  }

  // --- phases --------------------------------------------------------------

  private async plan(): Promise<Plan> {
    // A resumed run already has its plan; re-planning would discard the work
    // that survived, which is the whole point of resuming.
    if (this.options.resume && this.w.tasks.all().length > 0) {
      const stored = await this.w.board.get("plan.full");
      log.info(`resuming with ${this.w.tasks.all().length} existing task(s)`);
      await this.w.ledger.record("run.phase", "orchestrator", { phase: "plan", resumed: true });
      if (stored) return stored.value as Plan;
      // The task graph is the authority; a missing plan record is cosmetic.
      return {
        summary: "(resumed run; original plan record unavailable)",
        stack: {},
        integrations: [],
        tasks: this.w.tasks.all().map((task) => ({
          id: task.id,
          title: task.title,
          brief: task.brief,
          paths: task.paths,
          dependsOn: task.dependsOn,
          role: task.role as "builder",
        })),
      };
    }

    await this.w.ledger.record("run.phase", "orchestrator", { phase: "plan" });

    const architect = this.agent("architect-1", "architect", this.builderProvider, this.builderModel);
    const available = Object.entries(integrationStatus(this.w.integrations))
      .map(([name, state]) => `- ${name}: ${state}`)
      .join("\n");

    let lastProblems = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const outcome = await architect.run({
        instruction:
          `Produce the build plan for this project specification.\n\n` +
          `--- specification ---\n${this.options.spec}\n--- end specification ---`,
        context:
          `Integrations configured for this run:\n${available}\n\n` +
          `Capabilities granted to this run: ${[...this.config.grants].join(", ")}\n` +
          `Parallel builders available: ${this.parallelism}` +
          (lastProblems ? `\n\nYour previous plan was rejected:\n${lastProblems}` : ""),
        maxTurns: 6,
      });

      // A run that stopped for a reason of its own - halted, out of budget, the
      // provider failing - must report that reason, not be retried and then
      // blamed on the architect's JSON.
      if (outcome.kind === "halted" || outcome.kind === "budget" || outcome.kind === "error") {
        throw new Error(`planning stopped (${outcome.kind}): ${outcome.text}`);
      }

      const raw = outcome.signal ? JSON.stringify(outcome.signal.payload) : outcome.text;
      if (!raw.trim()) {
        lastProblems = "you returned nothing; return the JSON plan object";
        continue;
      }

      try {
        const plan = parsePlan(raw);
        const problems = validatePlan(plan, { maxTasks: this.config.HIVE_MAX_TASKS });
        if (problems.length > 0) {
          lastProblems = problems.map((p) => `- ${p.detail}`).join("\n");
          log.warn(`plan attempt ${attempt} rejected`, lastProblems);
          continue;
        }
        await this.adoptPlan(plan);
        return plan;
      } catch (err) {
        lastProblems = `your reply did not parse as the required JSON object: ${String(err)}`;
        log.warn(`plan attempt ${attempt} unparseable`, lastProblems);
      }
    }

    throw new Error(`architect could not produce a valid plan:\n${lastProblems}`);
  }

  private async adoptPlan(plan: Plan): Promise<void> {
    for (const task of plan.tasks) {
      await this.w.tasks.add({
        id: `${task.id}`,
        title: task.title,
        brief: task.brief,
        paths: task.paths,
        dependsOn: task.dependsOn,
        role: task.role as Role,
      });
    }
    const cycles = this.w.tasks.cycles();
    if (cycles.length > 0) {
      throw new Error(`plan contains a dependency cycle: ${cycles[0]?.join(" -> ")}`);
    }
    // The provider choice is part of the run, not of the command that started
    // it: a resume that silently swaps models is a different run.
    await this.w.board.put(
      "run.config",
      {
        provider: this.builderProvider,
        model: this.builderModel,
        reviewProvider: this.reviewerProvider,
        reviewModel: this.reviewerModel,
      },
      "orchestrator",
    );
    await this.w.board.put("plan.full", plan, "architect-1");
    await this.w.board.put("plan.summary", plan.summary, "architect-1");
    await this.w.board.put("plan.stack", plan.stack, "architect-1");
    log.info(`plan adopted: ${plan.tasks.length} tasks`);
  }

  /** Build and review every task, respecting dependencies and file ownership. */
  private async execute(): Promise<{ done: number; failed: number }> {
    await this.w.ledger.record("run.phase", "orchestrator", { phase: "execute" });

    // A task that was mid-flight when the process died has no agent behind it
    // any more. Its worktree survives, so returning it to the ready set resumes
    // the work rather than restarting it.
    for (const task of this.w.tasks.byStatus("in_progress", "in_review")) {
      await this.w.tasks.update(task.id, {
        status: "changes_requested",
        feedback:
          task.feedback ??
          "This task was interrupted before it finished. Your previous work is still in your checkout; continue from there.",
      });
      log.info(`recovered interrupted task ${task.id}`);
    }

    let guard = 0;
    const guardLimit = this.w.tasks.all().length * (this.config.HIVE_MAX_REVIEW_ROUNDS + 2) + 10;

    while (!this.w.tasks.isComplete) {
      this.w.kill.assertLive();
      if (guard++ > guardLimit) {
        log.error("execute loop hit its iteration guard; abandoning the remainder");
        break;
      }

      // Anything waiting on work that will never finish is abandoned, or the
      // loop spins with an empty ready set and nothing in flight.
      for (const task of this.w.tasks.stuck()) {
        await this.w.tasks.update(task.id, {
          status: "abandoned",
          feedback: "an upstream task was abandoned",
        });
      }

      const batch = this.selectBatch();
      if (batch.length === 0) {
        const remaining = this.w.tasks.all().filter(
          (t) => t.status !== "done" && t.status !== "abandoned",
        );
        if (remaining.length > 0) {
          log.warn(`no runnable task but ${remaining.length} unfinished; abandoning them`);
          for (const task of remaining) {
            await this.w.tasks.update(task.id, { status: "abandoned", feedback: "no path to start" });
          }
        }
        break;
      }

      await Promise.all(batch.map((task, index) => this.buildAndReview(task, index)));
    }

    const done = this.w.tasks.byStatus("done").length;
    const failed = this.w.tasks.all().length - done;
    return { done, failed };
  }

  /**
   * Choose the next set of tasks to run at once.
   *
   * Two constraints: the parallelism cap, and file ownership. Two agents editing
   * the same file concurrently is the fastest way for a parallel build to
   * produce something neither of them intended.
   */
  private selectBatch(): Task[] {
    const claimed = new Set<string>();
    const batch: Task[] = [];
    for (const task of this.w.tasks.ready()) {
      if (batch.length >= this.parallelism) break;
      if (task.paths.some((path) => claimed.has(path))) continue;
      task.paths.forEach((path) => claimed.add(path));
      batch.push(task);
    }
    return batch;
  }

  private async buildAndReview(task: Task, slot: number): Promise<void> {
    const builderId = `builder-${slot + 1}`;
    const current = this.w.tasks.get(task.id);

    // A task returning after a failed merge starts from a fresh checkout of the
    // current head; one returning after ordinary review feedback keeps its work.
    const worktree = await this.w.workspaces.forTask(task.id, {
      fresh: current.feedback?.startsWith("merge conflict") ?? false,
    });
    await this.w.tasks.update(task.id, { status: "in_progress", assignee: builderId });

    const builder = this.agent(builderId, "builder", this.builderProvider, this.builderModel, worktree);
    const outcome = await builder.run({
      instruction: this.taskBrief(current),
      context:
        `You are working in an isolated checkout of the project at the root of your workspace. ` +
        `Other builders are working in their own checkouts at the same time, so files outside ` +
        `this task's scope may change under you before your work is merged.`,
      taskId: task.id,
    });

    const signal = outcome.signal?.name;
    if (signal === "block_task") {
      const reason = String(outcome.signal?.payload.reason ?? "blocked");
      await this.w.tasks.update(task.id, { status: "abandoned", feedback: reason }, builderId);
      await this.w.workspaces.discardTask(task.id);
      await this.w.bus.send({
        from: builderId,
        to: "architect",
        kind: "blocker",
        subject: `blocked on ${task.id}: ${current.title}`,
        body: reason,
        taskId: task.id,
      });
      return;
    }

    if (signal !== "complete_task") {
      // finishUnsignalled throws for a halt or an exhausted budget, which leaves
      // the worktree intact on purpose: that work is what a resume recovers.
      await this.finishUnsignalled(task.id, builderId, outcome);
      await this.w.workspaces.discardTask(task.id);
      return;
    }

    const summary = String(outcome.signal?.payload.summary ?? "");
    const commit = await this.w.workspaces.commitTask(
      task.id,
      `hive ${task.id}: ${current.title}`,
    );
    await this.w.ledger.record("task.status", builderId, {
      taskId: task.id,
      committed: commit.committed,
      filesChanged: commit.filesChanged,
    });

    // A builder that declared completion but changed nothing has not done the
    // task - unless it explicitly says nothing needed changing, which is a real
    // outcome for a task whose work turned out to be already present. The claim
    // is not taken on trust: it goes to review like any other, with the reviewer
    // told to check it.
    const claimsNoChanges = outcome.signal?.payload.noChangesNeeded === true;
    if (!commit.committed && !claimsNoChanges) {
      return this.rejectTask(
        task.id,
        current,
        "You called complete_task but the checkout contains no changes. Either make the changes the brief asks for, or set no_changes_needed and explain how you established that nothing was needed.",
      );
    }

    await this.w.tasks.update(task.id, { status: "in_review" }, builderId);
    const diff = commit.committed
      ? await this.w.workspaces.diffTask(task.id)
      : "(the builder reports that no file needed to change - verify that claim)";
    const verdict = await this.review(this.w.tasks.get(task.id), summary, worktree, diff);

    if (!verdict.approved) {
      return this.rejectTask(task.id, this.w.tasks.get(task.id), verdict.summary, {
        judged: verdict.judged,
      });
    }

    if (!commit.committed) {
      await this.w.tasks.update(task.id, { status: "done", feedback: verdict.summary }, "reviewer-1");
      await this.w.workspaces.discardTask(task.id);
      return;
    }

    const merge = await this.w.workspaces.mergeTask(task.id);
    if (!merge.merged) {
      // The reviewer approved the code; it simply no longer applies to the head
      // it must land on. That is a rebuild, not a review failure.
      await this.w.ledger.record("task.status", "orchestrator", {
        taskId: task.id,
        merge: "conflict",
        conflicts: merge.conflicts,
      });
      return this.rejectTask(
        task.id,
        this.w.tasks.get(task.id),
        `merge conflict: your work was approved but no longer applies to the integration branch. ` +
          `Conflicting files: ${merge.conflicts.join(", ") || "unknown"}. ` +
          `You have a fresh checkout of the current code; redo the change on top of it.`,
        // The reviewer approved this work. Being overtaken by another merge is
        // not a failure to converge, and must not be charged as one.
        { judged: false },
      );
    }

    await this.w.tasks.update(task.id, { status: "done", feedback: verdict.summary }, "reviewer-1");
    await this.w.workspaces.discardTask(task.id);
  }

  /**
   * Send a task back for another round, or give up on it.
   *
   * A loop that will not converge is a real outcome and must cost a bounded
   * amount, so the round count is the same whether the rejection came from the
   * reviewer, from an empty commit, or from a failed merge.
   */
  private async rejectTask(
    taskId: string,
    task: Task,
    feedback: string,
    options: { judged?: boolean } = {},
  ): Promise<void> {
    // A round is spent only when a reviewer actually judged the work. A
    // reviewer that ran out of turns, a merge that no longer applies, or a
    // provider that could not authenticate say nothing about whether the task
    // is converging, and charging them to its budget abandons work that was
    // never given a fair hearing.
    const judged = options.judged ?? true;
    const rounds = task.reviewRounds + (judged ? 1 : 0);
    const attempts = task.attempts + 1;

    // Unjudged retries still need a ceiling of their own, or a task whose
    // reviewer keeps failing would be dispatched forever.
    const roundsSpent = rounds >= this.config.HIVE_MAX_REVIEW_ROUNDS;
    const attemptsSpent = attempts >= this.config.HIVE_MAX_REVIEW_ROUNDS * 2 + 2;

    if (roundsSpent || attemptsSpent) {
      const why = roundsSpent
        ? `did not converge after ${rounds} review round(s)`
        : `gave up after ${attempts} attempts, most of them lost to failures outside the task`;
      await this.w.tasks.update(
        taskId,
        {
          status: "abandoned",
          reviewRounds: rounds,
          attempts,
          feedback: `${why}. Last feedback:\n${feedback}`,
        },
        "reviewer-1",
      );
      await this.w.workspaces.discardTask(taskId);
      return;
    }

    await this.w.tasks.update(
      taskId,
      { status: "changes_requested", reviewRounds: rounds, attempts, feedback },
      "reviewer-1",
    );
  }

  private async review(
    task: Task,
    builderSummary: string,
    worktree: string,
    diff: string,
  ): Promise<{ approved: boolean; summary: string; judged: boolean }> {
    const reviewer = this.agent(
      "reviewer-1",
      "reviewer",
      this.reviewerProvider,
      this.reviewerModel,
      // The reviewer reads the builder's own checkout, so it can run the tests
      // against exactly the code it is judging.
      worktree,
    );
    const outcome = await reviewer.run({
      instruction:
        `Review task ${task.id}: ${task.title}\n\n` +
        `--- brief given to the builder ---\n${task.brief}\n\n` +
        `--- files the task owns ---\n${task.paths.join("\n") || "(not specified)"}\n\n` +
        `--- the builder's own summary ---\n${builderSummary}\n\n` +
        `--- the diff you are reviewing ---\n${diff}`,
      context:
        `This is review round ${task.reviewRounds + 1} of ${this.config.HIVE_MAX_REVIEW_ROUNDS}. ` +
        `If the work satisfies the brief, approve it; do not withhold approval over style.`,
      taskId: task.id,
      // Reviewing an HTTP service means starting it and probing it; twelve
      // turns was not enough and the verdict was the thing that got cut.
      maxTurns: this.config.HIVE_MAX_TURNS,
    });

    if (outcome.signal?.name === "submit_review") {
      const payload = outcome.signal.payload;
      return {
        approved: payload.verdict === "approve",
        summary: String(payload.summary ?? ""),
        judged: true,
      };
    }

    // A reviewer that never rendered a verdict must not silently pass work
    // through: treat the absence of an approval as a request for changes.
    return {
      approved: false,
      // Nothing was judged: this is the reviewer failing, not the work.
      judged: false,
      summary:
        `The reviewer did not return a verdict (${outcome.kind}). Treat the work as unreviewed ` +
        `and re-check it against the brief yourself.\n${outcome.text.slice(0, 2000)}`,
    };
  }

  /**
   * Close out a task whose agent stopped without saying why.
   *
   * A halt, an exhausted budget, or a provider that cannot authenticate are all
   * facts about the *run*, not judgements on the task: the work in its worktree
   * may be perfectly good. Those leave the task recoverable so a resumed run
   * picks it back up, and stop the run itself - continuing would only burn the
   * remaining tasks against the same broken layer. Anything else is the task's
   * own failure and is abandoned.
   */
  private async finishUnsignalled(taskId: string, actor: string, outcome: AgentOutcome): Promise<void> {
    if (outcome.kind === "halted" || outcome.kind === "budget" || outcome.kind === "error") {
      const reason =
        outcome.kind === "halted"
          ? `the run was halted while this task was in flight: ${outcome.text}`
          : outcome.kind === "budget"
            ? `the run's spend or time cap was reached while this task was in flight: ${outcome.text}`
            : `the model provider failed while this task was in flight: ${outcome.text}`;
      await this.w.tasks.update(taskId, { status: "changes_requested", feedback: reason }, actor);
      // Trip the switch so every other in-flight agent unwinds too, instead of
      // each one discovering the same exhausted budget separately.
      this.w.kill.trip(reason);
      this.w.kill.assertLive();
      return;
    }

    const reason =
      outcome.kind === "turn_limit"
        ? `the builder used all ${outcome.turns} of its turns without finishing`
        : `the builder ended without completing (${outcome.kind}): ${outcome.text.slice(0, 500)}`;
    await this.w.tasks.update(taskId, { status: "abandoned", feedback: reason }, actor);
  }

  /**
   * Push the integration branch and open a pull request.
   *
   * Deterministic code rather than an agent, for the same reason the conductor
   * is: there is no judgement in "commit this tree and open a PR for it". The
   * first live attempt at this went through an agent, which had to discover the
   * mechanics itself and then failed on an environment restriction it had no
   * way to route around - having spent a model call to get there.
   */
  private async publish(): Promise<{
    ok: boolean;
    detail: string;
    result?: RunReport["published"];
  }> {
    await this.w.ledger.record("run.phase", "orchestrator", { phase: "publish" });

    const github = this.w.integrations.github;
    if (!github.available()) {
      return { ok: true, detail: `skipped (${github.unavailableReason()})` };
    }
    if (!this.config.grants.has("github:write")) {
      return { ok: true, detail: "skipped (github:write is not granted to this run)" };
    }

    const repo = github.defaultRepo();
    if (!repo) return { ok: false, detail: "GITHUB_REPO is not a valid owner/repo" };

    const files = await this.w.workspaces.filesAtHead();
    // .gitignore is scaffolding this run created, not part of the project.
    const payload = files.filter((file) => file.path !== ".gitignore");
    if (payload.length === 0) {
      return { ok: false, detail: "nothing to publish: the integration branch is empty" };
    }

    const branch = `hive/${this.runId}`;
    try {
      const pushed = await github.pushTree(
        repo,
        branch,
        payload,
        `hive: ${this.options.spec.split("\n")[0]?.replace(/^#\s*/, "") ?? this.runId}`,
      );

      const summary = await this.w.board.get("plan.summary");
      const pr = await github.openPullRequest(
        repo,
        branch,
        (await github.getRepo(repo)).default_branch,
        `hive: ${branch}`,
        this.pullRequestBody(String(summary?.value ?? "")),
      );

      const result = { branch, commit: pushed.commit, pullRequest: pr.html_url };
      await this.w.board.put("ship.published", result, "orchestrator");
      await this.w.ledger.record("integration.call", "orchestrator", {
        service: "github",
        operation: "publish",
        branch,
        files: payload.length,
        pullRequest: pr.number,
      });
      log.info(`published ${payload.length} file(s) to ${branch}; PR ${pr.html_url}`);
      return {
        ok: true,
        detail: `${payload.length} file(s) on ${branch}; ${pr.html_url}`,
        result,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.w.ledger.record("error", "orchestrator", { stage: "publish", error: message });
      return { ok: false, detail: `could not publish: ${message}` };
    }
  }

  private pullRequestBody(summary: string): string {
    const tasks = this.w.tasks
      .all()
      .map((task) => `- \`${task.id}\` **${task.title}** - ${task.status}`)
      .join("\n");
    return [
      summary || "Built autonomously by hive.",
      "",
      "## Tasks",
      tasks,
      "",
      `Each task was built in its own worktree and reviewed before merging.`,
      `Run \`${this.runId}\` - ${this.w.budget.summary()}`,
    ].join("\n");
  }

  /** Run one agent for a whole phase (integration, ship) and report the outcome. */
  private async runSingle(role: Role, instruction: string): Promise<{ ok: boolean; detail: string }> {
    await this.w.ledger.record("run.phase", "orchestrator", { phase: role });
    const agent = this.agent(`${role}-1`, role, this.builderProvider, this.builderModel);
    const outcome = await agent.run({ instruction, maxTurns: this.config.HIVE_MAX_TURNS });

    if (outcome.signal?.name === "complete_task") {
      return { ok: true, detail: String(outcome.signal.payload.summary ?? "completed") };
    }
    if (outcome.signal?.name === "block_task") {
      return { ok: false, detail: String(outcome.signal.payload.reason ?? "blocked") };
    }
    return { ok: false, detail: `${role} ended without completing (${outcome.kind})` };
  }

  // --- briefs --------------------------------------------------------------

  private taskBrief(task: Task): string {
    const feedback = task.feedback
      ? `\n\n--- review feedback you must address ---\n${task.feedback}`
      : "";
    return (
      `Task ${task.id}: ${task.title}\n\n${task.brief}\n\n` +
      `Files you own: ${task.paths.join(", ") || "(decide, but stay within this task's scope)"}` +
      feedback
    );
  }

  private integrationBrief(): string {
    const abandoned = this.w.tasks
      .byStatus("abandoned")
      .map((t) => `- ${t.id} ${t.title}: ${t.feedback ?? "no reason recorded"}`)
      .join("\n");
    return (
      `Every task has been built and reviewed individually. Make the project work as one thing.\n\n` +
      `Install dependencies, build it, and run the tests from the workspace root. ` +
      `Fix small integration failures yourself; raise larger ones with add_task.\n\n` +
      (abandoned
        ? `These tasks did not complete, so their work may be missing or partial:\n${abandoned}\n\n`
        : "") +
      `Finish by publishing build and run instructions to the blackboard under "project.runbook", ` +
      `then call complete_task.`
    );
  }

  private shipBrief(published?: RunReport["published"]): string {
    const status = Object.entries(integrationStatus(this.w.integrations))
      .map(([name, state]) => `- ${name}: ${state}`)
      .join("\n");
    return (
      `The project builds and its tests pass.\n\n` +
      (published
        ? `The code is already published: branch ${published.branch}, commit ` +
          `${published.commit.slice(0, 8)}, pull request ${published.pullRequest}. ` +
          `Do not push it again.\n\n`
        : `The code has not been published to source control in this run.\n\n`) +
      `Integrations for this run:\n${status}\n\n` +
      `Your job is what remains: provision the database the app needs, set the environment ` +
      `variables, deploy if you have been granted deploy capability, verify the deployment ` +
      `actually responds, and send one summary email. Skip any step whose service is ` +
      `unavailable and record the gap on the blackboard rather than simulating it. ` +
      `Finish with complete_task.`
    );
  }

  // --- wiring --------------------------------------------------------------

  /**
   * @param workspace the checkout this agent works in - a task worktree for a
   *   builder or its reviewer, the integration branch for everyone else.
   */
  private agent(
    agentId: string,
    role: Role,
    providerId: string,
    model: string,
    workspace: string = this.workspace,
  ): Agent {
    const provider = this.w.providers.get(providerId);
    const spec: AgentSpec = {
      id: agentId,
      role,
      provider: providerId,
      model: this.modelFor(role, providerId, model),
      // An agent may hold only what its role's tools actually need, intersected
      // with what the run was granted.
      capabilities: this.w.tools
        .capabilitiesForRole(role)
        .filter((capability) => this.config.grants.has(capability)),
    };
    const context: Omit<ToolContext, "agent" | "taskId" | "log"> = {
      runId: this.runId,
      workspace,
      bus: this.w.bus,
      board: this.w.board,
      tasks: this.w.tasks,
      ledger: this.w.ledger,
      policy:
        workspace === this.workspace
          ? this.w.policy
          : new PolicyEngine({ runGrants: this.config.grants, workspace }),
      budget: this.w.budget,
      kill: this.w.kill,
      integrations: this.w.integrations,
    };
    return new Agent(spec, provider, this.w.tools, context);
  }

  /**
   * The model a role runs on.
   *
   * An explicit --model wins. Otherwise judgement roles get the provider's
   * strongest model and the rest get HIVE_WORKER_MODEL when it is set, which is
   * where the tokens actually go: a builder loop runs many more turns than an
   * architect, against a brief that has already been decided.
   */
  private modelFor(role: Role, providerId: string, requested: string): string {
    if (this.options.model) return requested;
    if (needsStrongestModel(role)) return requested;
    const worker = this.config.HIVE_WORKER_MODEL;
    // Only meaningful for the API providers; a CLI provider names its own model.
    return worker && providerId === "anthropic" ? worker : requested;
  }

  private get builderProvider(): string {
    return this.options.provider ?? "anthropic";
  }

  private get builderModel(): string {
    return this.options.model ?? this.w.providers.get(this.builderProvider).defaultModel;
  }

  private get reviewerProvider(): string {
    return this.options.reviewProvider ?? this.w.providers.pickContrasting(this.builderProvider);
  }

  private get reviewerModel(): string {
    return this.options.reviewModel ?? this.w.providers.get(this.reviewerProvider).defaultModel;
  }

  private get parallelism(): number {
    return this.options.parallelism ?? this.config.HIVE_MAX_PARALLEL;
  }
}
