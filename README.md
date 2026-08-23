# hive

An autonomous multi-model engineering swarm. You give it a project specification;
a group of AI agents — running on different vendors' models — plan it, build it in
parallel, review each other's work, integrate it, and ship it to GitHub, Neon,
Railway, Clerk and Resend. No human in the loop, and a kill switch when you want
one back.

```bash
npm install
cp .env.example .env                 # add at least ANTHROPIC_API_KEY
npm run hive -- verify               # prove every credential actually works
npm run hive -- plan  --spec examples/url-shortener.md   # cheap: plan only
npm run hive -- build --spec examples/url-shortener.md
```

To watch it work, in another shell: `tail -f .hive/runs/<run-id>.jsonl`.
To stop everything, from any shell: `npm run hive -- halt`.

---

## What it actually does

A run moves through five phases. The sequencing is ordinary code; the work inside
each phase is done by models.

| Phase | Who | What happens |
|---|---|---|
| **plan** | architect | Turns the spec into a validated task DAG, with file ownership and dependencies |
| **execute** | builders + reviewer | Ready tasks run in parallel; each completed task is reviewed before it counts as done |
| **integrate** | integrator | Installs, builds and tests the whole thing together, fixes the seams |
| **ship** | operator | Pushes to GitHub, branches the Neon database, sets Railway variables, deploys, verifies, emails you the outcome |

Agents talk to each other through an addressed message bus (`send_message`) and
agree on things through a versioned blackboard (`board_write`) — the chosen
stack, the schema, the API contract, the deploy URL. Everything that happens is
appended to a ledger you can replay with `hive report <run-id>`.

## Why more than one model

The reviewer deliberately runs on a **different vendor** than the builder.

This is the whole reason the system is multi-model rather than one model called
repeatedly. Model families share failure modes with themselves far more than with
each other: a model reviewing code written by its own family tends to accept the
same wrong assumptions that produced it. A reviewer from a different family is an
actual second opinion. If you only configure one vendor, the run still works and
the report says so explicitly:

```
notes
  - single-vendor run: anthropic both builds and reviews - configure a second
    provider for independent review
```

Providers ship for Anthropic (default, `claude-opus-5`), OpenAI, Gemini, a mock
for tests, and locally installed agent CLIs (`claude`, `codex`, `gemini`) driven
as subprocesses. Pick per run:

```bash
npm run hive -- build --spec spec.md --provider anthropic --review-provider gemini
```

## Isolation

Every task builds in its **own git worktree**, branched from the integration head
at the moment it is dispatched. Nothing reaches the integration branch except
through an explicit merge of approved work.

```
* 1c3cb2d  hive: merge t2
|\
| * 138107f  hive t2: Add a smoke test
|/
*   a3815db  hive: merge t1
|\
| * c306f6e  hive t1: Implement the service entrypoint
|/
* d60152c  hive run run_4dbf58c98d76: base
```

This matters more than it looks. File-ownership rules stop two builders from
*claiming* the same file, but an agent can always read — and be misled by — a
file another agent is halfway through writing. With worktrees, a collision
surfaces as a **merge conflict**, which is a thing you can hand back to a
builder, instead of as code that looks fine and is wrong.

Consequences that fall out of this:

- A dependent task branches from the head *after* its predecessor merged, so it
  sees that work with no explicit hand-off.
- The reviewer reads the builder's own checkout and gets the **diff**, so it
  reviews what changed rather than the whole tree — and runs the tests against
  exactly the code it is judging.
- A task that declares completion with an empty diff is rejected. Saying you
  finished is not finishing.
- An approved task whose merge conflicts is sent back with a fresh checkout of
  the current head — the code was right, it just no longer applies.
- A failed merge is always aborted, so the integration branch is never left
  stuck mid-merge for every later task to inherit.

## Guardrails

"No human contact" means the limits have to be in code, decided before the run —
not in a prompt, and not in an agent's judgement at three in the morning.

**Capabilities.** Every side-effecting tool declares one. A tool runs only if the
run was granted that capability *and* the agent's role holds it. Four are withheld
by default because they do things you cannot undo by re-running the build:

```
db:destructive   deploy:production   email:send   auth:admin
```

Grant them explicitly in `HIVE_GRANTS` when you mean it. A denied tool returns a
refusal the agent can read and route around; it cannot escalate.

**Spend and time.** Checked before every model call, charged after every one:
`HIVE_MAX_USD` per run, `HIVE_MAX_AGENT_USD` per agent, `HIVE_WALL_CLOCK_MINUTES`
overall. An unpriced model is costed pessimistically so it trips the cap early
rather than late.

**Command inspection.** Beyond `shell:exec`, the command text itself is checked.
`sudo`, `rm -rf /`, `git push --force` without a lease, `DROP DATABASE`,
pipe-to-shell installs and credential exfiltration are refused as hard rules, not
as permissions an agent can request. Provider credentials are stripped from the
environment of every command an agent runs.

**Confinement.** Filesystem tools resolve every path against the run's workspace
and refuse anything that escapes it.

**Convergence.** A review loop that will not settle is stopped after
`HIVE_MAX_REVIEW_ROUNDS`. A task whose dependency was abandoned is abandoned
rather than waited on. A reviewer that talks without rendering a verdict counts
as *request changes*, never as approval.

**The kill switch.** `hive halt` writes `.hive/HALT`; every agent checks it before
each model call and each tool call. It is a file rather than a signal precisely so
you can stop a run from any shell, even one that has stopped responding.

## Configuration

Everything is environment variables — see `.env.example`, which is annotated.
Nothing is mandatory except one model provider. A service without credentials
reports itself unavailable, and the operator agent routes around it and records
the gap instead of pretending it deployed.

Set `HIVE_DATABASE_URL` to a Neon branch to make run state durable; without it a
run keeps state in memory and is lost if the process dies.

## Commands

```
hive build --spec <file>   Plan, build, review, integrate and ship
hive plan  --spec <file>   Produce and validate a plan only, and stop
hive doctor                What is configured, what is granted, what is withheld
hive verify                Prove every credential works, with real read-only calls
hive halt [reason]         Stop every run at its next checkpoint
hive resume                Clear a halt
hive report <run-id>       Replay a run's ledger
```

**Run `hive verify` before any unattended build.** `doctor` reports what your
environment *claims*; `verify` makes a real read-only call to each service and
reports what they say back. The difference is not academic:

```
services
  FAIL github       github 401: Bad credentials (159ms)
```

That token was set, so `doctor` called it available. An unattended run would
have discovered it in the ship phase, after spending the entire build budget
getting there.

`--dry-run` does everything except contact an external service. It is the right
way to try a new spec.

## Development

```bash
npm test          # 52 tests: guardrails, coordination, and a scripted end-to-end run
npm run typecheck
npm run demo      # a full run against the mock provider, no API key needed
```

The mock provider is not a stub — it plays a plausible swarm member well enough
to drive the whole pipeline, which is what makes the interesting failure modes
(a review that never converges, a stranded dependency, a budget that runs out
mid-plan) reproducible in tests.

## Honest limits

- **CLI-backed agents can plan and review, not build.** A CLI agent runs its own
  tool loop in its own process, so the hive cannot gate its tool calls or see its
  spend. `hive plan --provider claude-code` works today and needs no API key;
  building through a CLI agent does not.
- **A run is not resumable.** State persists to Postgres, but there is no
  `hive resume <run-id>` that picks a half-finished run back up.
- **OpenAI and Gemini costs are estimates.** Only Anthropic rates are in the
  pricing table; the others are costed at Opus/Sonnet-equivalent rates so the cap
  errs toward stopping too early.
- **Model ids move.** Anthropic's default is pinned; set `OPENAI_MODEL` and
  `GEMINI_MODEL` yourself rather than trusting this repo's defaults.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for why it is shaped this way.
