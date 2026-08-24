# Architecture

Notes on why this is shaped the way it is. The design decisions that cost the
most to get wrong are the ones about coordination and about what an unattended
agent is allowed to do — not about which model is used.

## The shape of a run

```
spec ──► architect ──► task DAG ──┐
                                  │
        ┌─────────────────────────┘
        ▼
   ready tasks ──► builder ──► reviewer ──► done
        ▲             │            │
        │             │            └─ request changes ─┐
        │             └─ blocked ──► abandoned         │
        └──────────────────────────────────────────────┘
                          (bounded rounds)
                                  │
                                  ▼
                            integrator ──► operator ──► shipped
```

## Decisions

### The conductor is code, not a model

An LLM orchestrating LLMs compounds their variance. The sequencing of a build —
what may start, what must wait, when to stop trying — is exactly the part that has
to be predictable, so `Orchestrator` is a plain state machine with model-driven
steps inside it. Models decide *what* the code should be; code decides *what
happens next*.

### Mailboxes, not a group chat

"All the AIs talk to each other" is the natural way to describe this, and it is
the wrong way to build it. A shared channel where every agent sees every message
does not converge: everyone answers everyone, each agent's context inflates with
conversation it has no use for, and cost grows with the square of the swarm.

So messages are **addressed** (an agent id, a role, or `*`) and **threaded**, and
delivery is a mailbox drained on the recipient's next turn. An agent never blocks
waiting for a reply — if it cannot proceed it calls `block_task` and the graph
handles it. The only real synchronisation primitive is a task dependency.

### Two channels, because they carry different things

- **Messages** are how agents *ask*: transient, addressed, threaded.
- **The blackboard** is how agents *agree*: durable, keyed, versioned.

A decision that lives only in an agent's reasoning does not exist to anyone else,
and a decision buried in a message thread is one the next agent has to re-derive.
Anything a later agent must rely on — the schema, the API contract, the deploy URL
— goes on the blackboard under a stable key, and its truncated contents are
injected into every agent's opening turn.

### Cross-vendor review is the point

Model families share failure modes with themselves far more than with each other.
A model reviewing its own family's code tends to accept the same wrong assumptions
that generated it. So `ProviderRegistry.pickContrasting()` selects a reviewer from
a different vendor by default, and when it cannot, the run report says so rather
than letting a single-vendor run look like an independently reviewed one.

The reviewer's brief also constrains what counts as a blocking finding. Without
that, a reviewer rewrites the builder's design on taste and the loop never
converges — which is a cost problem, not just an annoyance.

### A missing verdict is not an approval

If a reviewer ends its turn without calling `submit_review`, the work is treated
as *changes requested*. The failure mode this prevents is the expensive one: a
reviewer that ran out of turns, hit its budget, or drifted into prose, silently
passing unreviewed code into an autonomous deploy.

The same principle runs through the loop. Every state that could be read as "fine,
carry on" has to be reached explicitly through a tool call, never by absence.

### Capabilities are decided before the run, not during it

There is nobody to ask mid-run, so the answer has to be written down in advance.
Every side-effecting tool declares a capability; a call is allowed only if the run
grants it *and* the agent's role holds it. Roles also determine which tools a model
is *shown* — a builder is never told `railway_deploy` exists, because the cheapest
guardrail is the one that keeps an option out of the context window entirely.

The four capabilities withheld by default (`db:destructive`, `deploy:production`,
`email:send`, `auth:admin`) are the ones whose effects cannot be undone by
re-running the build. Everything else can.

Command inspection sits *behind* the capability check rather than replacing it,
because "may run commands" should still not mean "may run `sudo rm -rf /`".

### The manual turn loop

`Agent.run()` is a hand-written loop rather than the SDK's tool runner, for three
reasons that are specific to this system: the budget must be consulted before
each model call and charged after it; the kill switch must be honoured between
every step; and one loop has to drive Anthropic, OpenAI, Gemini and CLI-backed
agents through a single normalised interface.

The provider abstraction is lossy on purpose — text, tool calls, tool results —
but each turn also carries the provider's own blocks in `native`, replayed
verbatim by the provider that produced them. That is what keeps Anthropic
thinking blocks intact across turns without leaking Anthropic's shape into the
other adapters.

### Prompt caching shapes the loop

The system prompt is fixed per role and marked cacheable. Everything volatile —
inbox, blackboard, task graph — goes into the message turns, never into the system
prompt, so the cached prefix survives the whole task. Mid-loop inbox delivery is
appended to tool-result turns rather than sent as its own call, so agents stay in
touch without paying for a round trip to find out they have no mail.

### A worktree per task, not a shared directory

File-ownership rules are necessary and not sufficient. They stop two builders
from claiming the same file; they cannot stop one from *reading* a file another
is halfway through writing, and being confidently wrong as a result.

So each task gets a real git checkout, branched from the integration head at
dispatch. Three properties follow, and all three are load-bearing:

1. **Branching at dispatch, not at plan time.** A dependent task branches after
   its predecessor merged, so it inherits that work without a hand-off protocol.
2. **The integration branch only advances by merge.** A collision becomes a
   merge conflict — a concrete artefact with a file list — rather than silently
   plausible code.
3. **A failed merge is aborted, never left in progress.** A repository stuck
   mid-merge would poison every task dispatched after it.

The retry semantics differ by *why* a task came back, which is the part worth
getting right: ordinary review feedback keeps the builder's checkout so it can
address the findings, while a merge conflict rebuilds the checkout from the
current head, because there the point is to redo the work against what landed.

Rejection is funnelled through one path (`rejectTask`) regardless of cause —
reviewer findings, an empty diff, or a failed merge — so the round budget is
spent identically however a task fails. Otherwise a task could ping-pong on
merge conflicts forever without ever consuming a review round.

### `doctor` and `verify` answer different questions

`doctor` reads the environment. `verify` calls the services. Keeping them apart
is deliberate: an unattended run's most expensive failure is a credential that
*looks* present, passes every startup check, and turns out to be dead in the
ship phase — after the entire build budget has been spent reaching it.

Every probe is read-only by construction. Resend's check lists domains rather
than sending a test message: a verification step must never itself reach a
person's inbox.

### Failure is a first-class outcome

An autonomous swarm fails in ways nobody sees, so every dead end has an explicit
terminal state and a recorded reason:

| Situation | Outcome |
|---|---|
| Builder cannot proceed | `block_task` → abandoned, architect notified |
| Review will not converge | abandoned after `HIVE_MAX_REVIEW_ROUNDS` |
| Dependency abandoned | dependents abandoned, not waited on |
| Reviewer gave no verdict | treated as changes requested |
| Budget or clock exhausted | run reports *why*, at the phase it happened |
| Halt requested | every agent stops at its next checkpoint |
| Completed with an empty diff | rejected — declaring completion is not finishing |
| Approved but unmergeable | fresh checkout of current head, rebuild |

The execute loop also carries an iteration guard. A guard that never fires costs
nothing; a swarm that spins overnight costs real money.

### Interruption is expected, not exceptional

An unattended run is exactly the kind of thing that gets killed halfway: a
laptop sleeps, a container is reclaimed, a budget runs out. So the question is
not whether a run survives its process but what it costs to continue.

State goes to local disk by default rather than needing Postgres first —
requiring a database to make resumption possible would mean nobody has it. The
part that took the most care is what a resume *keeps*: the plan (re-planning
would discard the surviving work), completed tasks (rebuilding them is the
expensive mistake), and the worktrees of interrupted tasks (that half-finished
work is the whole point).

That last one drove a behavioural change elsewhere. A halt or an exhausted
budget used to abandon whatever was in flight, which is wrong: those are facts
about the *run*, and the code in the worktree may be perfectly good. Both now
leave the task recoverable and stop the run by tripping the kill switch, so the
other in-flight agents unwind at once instead of each independently rediscovering
the same exhausted budget.

### Secrets and the broadcast channel

The blackboard is injected into every agent's context on every turn. That is
what makes it useful, and it is also why a database connection string published
there would be sent to every model in the swarm, repeatedly, for the rest of the
run.

So the rendered view names sensitive keys without showing their values, and an
agent that needs one fetches it deliberately with `board_read`. The distinction
worth preserving is between a fact everyone should have (the schema, the API
shape) and a capability only one agent needs (the credential to reach it).

### A CLI agent is a different kind of member

Most providers return tool calls for the hive to execute, which is what makes
the policy engine possible. A CLI-backed agent runs its own harness, so that
inversion does not apply: it is given a worktree and a restricted tool set, does
the work itself, and reports a structured verdict that is parsed into the same
control signal a tool call would have produced. The orchestrator needed no
changes to accommodate it, which is the useful test of whether the provider
abstraction was drawn in the right place.

The honest cost: the hive never sees the individual commands such an agent runs,
so command inspection does not apply inside it. Worktree confinement and the
role's tool list still do. Prefer an API provider where that gap matters.

### Ledger in two places

Every event is appended to Postgres *and* to a JSONL file. The file exists because
the store might be the thing that broke, and because `tail -f` is how you actually
watch an unattended run.

## Module map

```
src/
  kernel/       ledger, bus, blackboard, tasks, budget, policy, killswitch,
                workspace (git worktrees), store (file | postgres | memory)
  providers/    anthropic, openai, gemini, cli, mock, registry, pricing
  agents/       role prompts and the turn loop
  tools/        fs, shell, collaboration, integrations, per-role registry
  integrations/ github, neon, railway, clerk, resend
  orchestrator/ plan parsing and validation, the run state machine
```

The dependency direction is one-way: `orchestrator → agents → tools → kernel`.
Providers and integrations are leaves. Nothing in `kernel/` knows a model exists.
