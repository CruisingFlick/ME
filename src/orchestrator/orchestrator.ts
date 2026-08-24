import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Agent, type AgentOutcome } from "../agents/agent.js";
import { getConfig, type HiveConfig } from "../config.js";
import { Blackboard } from "../kernel/blackboard.js";
import { Budget } from "../kernel/budget.js";
import { MessageBus } from "../kernel/bus.js";
import { KillSwitch } from "../kernel/killswitch.js";
import { Ledger } from "../kernel/ledger.js";
import { PolicyEngine } from "../kernel/policy.js";
import { openStore, type Store } from "../kernel/store/index.js";
import { Workspaces } from "../kernel/workspace.js";
import { TaskGraph } from "../kernel/tasks.js";
import { buildIntegrations, integrationStatus, type Integrations } from "../integrations/index.js";
import { ProviderRegistry } from "../providers/registry.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import { ZERO_USAGE, type AgentSpec, type Role, type Task, type Usage } from "../types.js";
import { id } from "../util/id.js";
import { logger } from "../util/log.js";
import { parsePlan, validatePlan, type Plan } from "./plan.js";

const log = logger("orchestrator");

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

    const store = options.store ?? (await openStore());
    const ledger = new Ledger(store, runId, config.HIVE_STATE_DIR);
    const tasks = new TaskGraph(store, ledger, runId);
    await tasks.load();

    const w: Wiring = {
      ledger,
      tasks,
      bus: new MessageBus(store, ledger, runId),
      board: new Blackboard(store, ledger, runId),
      workspaces,
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

  async run(): Promise<RunReport> {
    const phases: RunReport["phases"] = [];
    const notes: string[] = [];
    let plan: Plan | undefined;
    let status: RunReport["status"] = "succeeded";

    // A halt left over from a previous run would stop this one before it starts.
    this.w.kill.reset();

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

      plan = await this.plan();
      phases.push({ phase: "plan", ok: true, detail: `${plan.tasks.length} tasks` });

      const built = await this.execute();
      phases.push({
        phase: "execute",
        ok: built.failed === 0,
        detail: `${built.done} done, ${built.failed} not completed`,
      });
      if (built.failed > 0) status = "failed";

      const integrated = await this.runSingle("integrator", this.integrationBrief());
      phases.push({ phase: "integrate", ok: integrated.ok, detail: integrated.detail });
      if (!integrated.ok) status = "failed";

      if (this.options.dryRun) {
        phases.push({ phase: "ship", ok: true, detail: "skipped (dry run)" });
        notes.push("dry run: no external service was contacted");
      } else if (status === "failed") {
        phases.push({ phase: "ship", ok: false, detail: "skipped (build did not reach green)" });
        notes.push("ship was skipped because an earlier phase failed");
      } else {
        const shipped = await this.runSingle("operator", this.shipBrief());
        phases.push({ phase: "ship", ok: shipped.ok, detail: shipped.detail });
        if (!shipped.ok) status = "failed";
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const halted = message.startsWith("run halted") || message.includes("(halted)");
      status = halted ? "halted" : "failed";
      phases.push({ phase: "run", ok: false, detail: message });
      notes.push(message);
      await this.w.ledger.record(halted ? "killswitch.tripped" : "error", "orchestrator", {
        error: message,
      });
      log.error(halted ? "run halted" : "run failed", message);
    }

    await this.w.workspaces.cleanup();

    const report: RunReport = {
      runId: this.runId,
      status,
      workspace: this.workspace,
      head: await this.w.workspaces.headSha(),
      filesTracked: await this.w.workspaces.fileCount(),
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
    if (!this.options.store) await this.store.close();
  }

  // --- phases --------------------------------------------------------------

  private async plan(): Promise<Plan> {
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
        const problems = validatePlan(plan);
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
    await this.w.board.put("plan.summary", plan.summary, "architect-1");
    await this.w.board.put("plan.stack", plan.stack, "architect-1");
    log.info(`plan adopted: ${plan.tasks.length} tasks`);
  }

  /** Build and review every task, respecting dependencies and file ownership. */
  private async execute(): Promise<{ done: number; failed: number }> {
    await this.w.ledger.record("run.phase", "orchestrator", { phase: "execute" });

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
      return this.rejectTask(task.id, this.w.tasks.get(task.id), verdict.summary);
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
  private async rejectTask(taskId: string, task: Task, feedback: string): Promise<void> {
    const rounds = task.reviewRounds + 1;
    if (rounds >= this.config.HIVE_MAX_REVIEW_ROUNDS) {
      await this.w.tasks.update(
        taskId,
        {
          status: "abandoned",
          reviewRounds: rounds,
          feedback: `did not converge after ${rounds} rounds. Last feedback:\n${feedback}`,
        },
        "reviewer-1",
      );
      await this.w.workspaces.discardTask(taskId);
      return;
    }
    await this.w.tasks.update(
      taskId,
      { status: "changes_requested", reviewRounds: rounds, feedback },
      "reviewer-1",
    );
  }

  private async review(
    task: Task,
    builderSummary: string,
    worktree: string,
    diff: string,
  ): Promise<{ approved: boolean; summary: string }> {
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
      maxTurns: 12,
    });

    if (outcome.signal?.name === "submit_review") {
      const payload = outcome.signal.payload;
      return {
        approved: payload.verdict === "approve",
        summary: String(payload.summary ?? ""),
      };
    }

    // A reviewer that never rendered a verdict must not silently pass work
    // through: treat the absence of an approval as a request for changes.
    return {
      approved: false,
      summary:
        `The reviewer did not return a verdict (${outcome.kind}). Treat the work as unreviewed ` +
        `and re-check it against the brief yourself.\n${outcome.text.slice(0, 2000)}`,
    };
  }

  private async finishUnsignalled(taskId: string, actor: string, outcome: AgentOutcome): Promise<void> {
    const reason =
      outcome.kind === "budget"
        ? `the run's spend or time cap was reached: ${outcome.text}`
        : outcome.kind === "halted"
          ? `the run was halted: ${outcome.text}`
          : outcome.kind === "turn_limit"
            ? `the builder used all ${outcome.turns} of its turns without finishing`
            : `the builder ended without completing (${outcome.kind}): ${outcome.text.slice(0, 500)}`;
    await this.w.tasks.update(taskId, { status: "abandoned", feedback: reason }, actor);
    if (outcome.kind === "halted") this.w.kill.assertLive();
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

  private shipBrief(): string {
    const status = Object.entries(integrationStatus(this.w.integrations))
      .map(([name, state]) => `- ${name}: ${state}`)
      .join("\n");
    return (
      `The project builds and its tests pass. Ship it.\n\n` +
      `Integrations for this run:\n${status}\n\n` +
      `Skip any step whose service is unavailable and record the gap on the blackboard. ` +
      `Push the code to a branch named hive/${this.runId}, open a pull request describing what was built, ` +
      `provision what the app needs, deploy if you have been granted deploy capability, verify it responds, ` +
      `then send one summary email. Finish with complete_task.`
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
      model,
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
