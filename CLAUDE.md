# hive — working notes

An autonomous multi-model engineering swarm. Read `README.md` for what it does
and `docs/ARCHITECTURE.md` for why it is shaped this way. This file is for
working *on* it.

## Commands

```bash
npm test                 # 150 tests, ~15s, no network
npm run typecheck
npm run demo             # full pipeline against the mock provider, no key needed
npm run hive -- doctor   # what is configured
npm run hive -- verify   # what actually works (real read-only calls)
```

A live run needs no API key if the Claude CLI is logged in:

```bash
npm run hive -- build --spec examples/greeting-lib.md --provider claude-code --dry-run
```

Use `--dry-run` unless you specifically mean to touch external services.
Budget every live run: `HIVE_MAX_USD=8 HIVE_WALL_CLOCK_MINUTES=30`. A real run
costs roughly $0.50–$1.00 per task with the CLI provider.

## Layout

```
src/kernel/       coordination and guardrails; knows nothing about models
src/providers/    one normalised interface over Anthropic, OpenAI, Gemini, CLI, mock
src/agents/       role prompts and the turn loop
src/tools/        what agents can do, and the capability each action needs
src/integrations/ github, neon, railway, clerk, resend
src/orchestrator/ plan validation and the run state machine
```

Dependencies run one way: `orchestrator → agents → tools → kernel`. Providers
and integrations are leaves. Keep it that way — `kernel/` must not learn that
models exist.

## Invariants worth not breaking

These each exist because the alternative failed in a real run:

- **Every terminal state is reached explicitly.** A missing review verdict is
  *request changes*, never approval. Nothing may pass by absence.
- **A completed task with an empty diff is rejected** unless it set
  `no_changes_needed`, and that claim goes to review like any other. "Empty"
  means the task's branch matches the integration branch - never "nothing was
  committed this round", which is normal on any retry.
- **A halt or exhausted budget leaves its in-flight tasks recoverable.** Those
  are facts about the run, not judgements on the task. All three stop causes -
  a cap, a provider out of quota, an operator - report as *halted* rather than
  failed, and each records which it was: a ledger that calls a quota exhaustion
  a tripped kill switch describes a decision nobody made. The cause must not
  depend on when it lands, either; an exhausted budget used to be *failed* from
  the plan phase and *halted* from execute.
- **An agent that answers in prose is nudged once.** It used to be nudged on
  every remaining turn, and a model that has already said its piece just says it
  again - five identical calls and a third of one run's spend for the plan that
  was there after the first reply. The single nudge carries the turn budget with
  it, because there is no second reminder.
- **Failed merges are always aborted, and report git's own reason.** A repo
  stuck mid-merge poisons every later task. And a merge refused *before* it
  starts - because loose files in the integration checkout block the checkout -
  leaves no unmerged paths at all, so inferring "conflict in 0 files" named the
  wrong cause and sent four tasks to be rebuilt against a conflict that did not
  exist. Loose work in the integration tree is committed, not deleted, before a
  merge: an agent wrote it.
- **A review round is spent only when a reviewer actually judged the work.** A
  reviewer that ran out of turns, or a merge overtaken by another, says nothing
  about whether the task is converging. Those retries have a ceiling of their
  own instead.
- **Rejection funnels through `rejectTask`** whatever the cause, so the round
  budget is spent identically and nothing can loop for free.
- **A project is published as one commit.** Pushing file by file through the
  contents API turned a 17-file project into 17 commits with one message, and
  every commit but the last was a tree that does not build - so anything
  watching the branch saw a broken project, and a run that died partway left one
  behind saying nothing. `pushTree` parents on the branch when it exists, or the
  default branch when it does not; parenting always on the default branch drops
  whatever an earlier push landed that this one does not mention.
- **Sensitive blackboard keys are withheld from the rendered board**, which goes
  into every agent's context on every turn.
- **An agent is told when its turns are nearly gone.** It cannot budget what it
  cannot see: a reviewer verifying carefully spent its last turn mid-inquiry and
  never rendered a verdict, so work it had all but approved came back unreviewed.
- **A process that dies says why.** Uncaught exceptions, unhandled rejections,
  signals and unexplained exits are all written to the ledger synchronously. A
  log that simply stops is the most expensive thing in this project to debug.
- **Every shell command returns.** `run_command` settles on its own timer and
  kills the whole process tree, because a shell's orphaned grandchild holds the
  stdout pipe open and `close` then never fires - a run that hangs with no
  error, no report and nothing in the ledger.
- **One process per run, enforced by a lock.** Two processes on one run claim
  the same task and spawn builders into the same worktree; the second then
  commits nothing and the task is rejected for "no changes".
- **Capabilities are decided before the run.** Nothing grants itself anything
  mid-run; there is nobody to ask.
- **The work graph has a ceiling.** `add_task` is how an integrator hands real
  discovered work to a builder instead of half-doing it itself, which is worth
  having - but a graph that grows every round does not converge, and the run
  then ends as an exhausted budget that names no cause. `HIVE_MAX_TASKS` bounds
  the plan and mid-run additions together; the refusal tells the agent to report
  the finding instead, so it is not lost.

## Testing

The mock provider is not a stub — it plays a plausible swarm member so the
interesting failures (non-converging review, stranded dependency, budget
exhausted mid-plan, merge conflict) are reproducible without a network.

When writing an orchestrator test, note that an agent's opening prompt contains
the *whole* work graph, so matching on a filename will hit the wrong task. Match
on the assignment header (`Task t2:`) instead. Both existing test stubs got this
wrong first.

## Before changing prompts in `src/agents/roles.ts`

They are written for an operating condition with no human: no questions, no
deferring to "the user", stop rather than improvise. Most swarm failures are an
agent inventing a plausible substitute for something it could not find. Keep
that pressure in any edit.
