# hive — working notes

An autonomous multi-model engineering swarm. Read `README.md` for what it does
and `docs/ARCHITECTURE.md` for why it is shaped this way. This file is for
working *on* it.

## Commands

```bash
npm test                 # 77 tests, ~10s, no network
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
  `no_changes_needed`, and that claim goes to review like any other.
- **A halt or exhausted budget leaves its in-flight tasks recoverable.** Those
  are facts about the run, not judgements on the task.
- **Failed merges are always aborted.** A repo stuck mid-merge poisons every
  later task.
- **Rejection funnels through `rejectTask`** whatever the cause, so the round
  budget is spent identically and nothing can loop for free.
- **Sensitive blackboard keys are withheld from the rendered board**, which goes
  into every agent's context on every turn.
- **Capabilities are decided before the run.** Nothing grants itself anything
  mid-run; there is nobody to ask.

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
