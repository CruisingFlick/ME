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

## What it has actually built

`examples/url-shortener.md` is a prose specification. Run unattended against it,
the swarm planned four tasks, built them in parallel worktrees, reviewed and
merged each one, and integrated the result:

```
status    succeeded
head      3146decf6fd7 - 13 file(s) tracked
spend     $2.6390 of $14.00 | 506s
  ok   plan       4 tasks
  ok   execute    4 done, 0 not completed
  ok   integrate  npm test: 17/17 passing
```

Verified independently afterwards — not taken from the integrator's report. The
project builds with `tsc`, passes 17 tests, and the running service satisfies
every requirement in the spec:

| Request | Response |
|---|---|
| `GET /health` | `{"ok":true}` 200 |
| `POST /links {"url":"https://example.com/..."}` | `{"slug":"JADiwX","short_url":"..."}` |
| `GET /JADiwX` | 302, `Location: https://example.com/...` |
| `GET /nosuchslug` | `{"error":"slug not found"}` 404 |
| `POST /links {"url":"not-a-url"}` | `{"error":"url must be an absolute http or https URL"}` 400 |

No human touched it between the specification and that table.

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
for tests, and locally installed agent CLIs. Pick per run:

```bash
npm run hive -- build --spec spec.md --provider anthropic --review-provider gemini
```

### Running with no API key at all

If you have the Claude Code CLI installed and logged in, that is enough — the
whole swarm runs through it, billed to your existing subscription:

```bash
npm run hive -- build --spec examples/greeting-lib.md --provider claude-code
```

A CLI-backed agent works differently from the API providers, and the difference
is worth understanding. The API providers hand back tool calls for the hive to
execute and gate. The CLI runs *its own* tool loop in its own process, so it is
instead handed a worktree and a restricted tool set, does the work itself, and
reports back a structured verdict that the hive turns into the same control
signal a tool call would have produced.

What you keep: worktree confinement, role-based tool limits (mapped onto the
CLI's own tool names), real measured spend, and every guardrail in the
orchestrator. What you give up: the policy engine cannot inspect individual
commands *inside* a CLI agent, because it never sees them. Prefer an API
provider when that matters.

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

**Secrets stay off the broadcast channel.** The blackboard is rendered into
every agent's context on every turn, so a value under a key that looks like a
credential (`infra.database`, anything matching password / token / connection /
secret) is named but withheld. An agent that genuinely needs one asks for it
with `board_read`. Provider credentials are also blanked from the environment of
every command an agent runs — including the hive's own state database, which is
not the built project's database.

**Convergence.** A review loop that will not settle is stopped after
`HIVE_MAX_REVIEW_ROUNDS`. A task whose dependency was abandoned is abandoned
rather than waited on. A reviewer that talks without rendering a verdict counts
as *request changes*, never as approval. The work graph itself is bounded by
`HIVE_MAX_TASKS`: an integrator can add work the plan missed, but not without
end, because a graph that grows every round never finishes.

**One process per run.** A run takes a lock naming the process holding it, and
a second one is refused rather than allowed to collide. Two processes on the
same run is a quiet, destructive failure: both claim the same task, both spawn
a builder into the same worktree, and the second commits nothing because the
first already committed the work — so a task that actually succeeded is sent
back for "no changes", at twice the cost. A lock whose process is gone is taken
over, so an interrupted run stays resumable.

**The kill switch.** `hive halt` writes `.hive/HALT`; every agent checks it before
each model call and each tool call. It is a file rather than a signal precisely so
you can stop a run from any shell, even one that has stopped responding.

## Durability

Run state — tasks, blackboard, messages, ledger — is written to local disk under
`.hive/state/<run-id>/`, so a run that loses its process has not lost what it
knew. Writes go through a temp file and a rename, and a torn final ledger line
is skipped rather than discarding the whole log.

```bash
npm run hive -- build --resume run_1b5ae5e47345
```

A resumed run reuses the stored plan instead of re-planning, does not rebuild
tasks that already landed, and **adopts the worktrees of tasks that were in
flight** — the interrupted work is the thing worth recovering. A halt or an
exhausted budget leaves its in-flight tasks recoverable rather than abandoning
them: that is a fact about the run, not a judgement on the task.

Set `HIVE_DATABASE_URL` to a Neon branch instead when several machines share a
run.

## Configuration

Everything is environment variables — see `.env.example`, which is annotated.
Nothing is mandatory except one model provider. A service without credentials
reports itself unavailable, and the operator agent routes around it and records
the gap instead of pretending it deployed.

## Commands

```
hive build --spec <file>   Plan, build, review, integrate and ship
hive build --resume <id>   Continue an interrupted run
hive plan  --spec <file>   Produce and validate a plan only, and stop
hive doctor                What is configured, what is granted, what is withheld
hive verify [--deep]       Prove every credential works, with real read-only calls
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

`--deep` goes further and **drives each model once**, end to end — the same
spawn, the same argument shape, the same response parsing a real run uses:

```
ok  claude-code  claude.CMD (2.1.246), model sonnet; answered in 4175ms: "READY"
```

This exists because a change to how the CLI process was spawned broke a run
between dispatching a task and its first model call — while the shallow check,
which only asks the binary for its version, still passed perfectly. Worth the
few cents before an unattended run; the CLI reports its own spend, so you will
see what the probe cost.

`--dry-run` does everything except contact an external service. It is the right
way to try a new spec.

## Development

```bash
npm test          # 89 tests: guardrails, coordination, isolation, live-run regressions
npm run typecheck
npm run demo      # a full run against the mock provider, no API key needed
```

The mock provider is not a stub — it plays a plausible swarm member well enough
to drive the whole pipeline, which is what makes the interesting failure modes
(a review that never converges, a stranded dependency, a budget that runs out
mid-plan) reproducible in tests.

## Honest limits

- **The policy engine cannot see inside a CLI-backed agent.** It runs its own
  tool loop, so command inspection does not apply there — only its worktree and
  its allowed tool list constrain it. Use an API provider where that matters.
- **The ship phase has never been exercised against live services.** Everything
  up to it is proven end to end with real models; pushing, provisioning and
  deploying are written and unit-tested but have not run against real GitHub,
  Neon or Railway credentials. Treat the first live ship as the shakedown.
- **OpenAI and Gemini costs are estimates.** Only Anthropic rates are in the
  pricing table; the others are costed at Opus/Sonnet-equivalent rates so the cap
  errs toward stopping too early.
- **Model ids move.** Anthropic's default is pinned; set `OPENAI_MODEL` and
  `GEMINI_MODEL` yourself rather than trusting this repo's defaults.
- **One integration checkout per run.** Repository operations are serialised, so
  parallel builders are safe, but throughput on merges is bounded by that queue.
  It has not been a bottleneck at the scales tried (up to 5 tasks, 3 in flight).

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for why it is shaped this way.
