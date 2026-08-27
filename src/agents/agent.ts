import { BudgetExceededError } from "../kernel/budget.js";
import { renderInbox } from "../kernel/bus.js";
import { HaltedError } from "../kernel/killswitch.js";
import { ProviderError, type ContentPart, type ModelProvider, type Turn } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import type { AgentSpec } from "../types.js";
import { truncate } from "../util/json.js";
import { logger } from "../util/log.js";
import { effortFor, systemPrompt } from "./roles.js";

export interface Assignment {
  /** The instruction for this turn-loop, e.g. a task brief or a review request. */
  instruction: string;
  taskId?: string;
  /** Extra read-only context appended after the instruction. */
  context?: string;
  maxTurns?: number;
}

export type AgentOutcomeKind =
  | "signal"
  | "text"
  | "halted"
  | "budget"
  | "error"
  | "turn_limit";

export interface AgentOutcome {
  kind: AgentOutcomeKind;
  /** Set when the loop ended because a tool raised a control signal. */
  signal?: { name: string; payload: Record<string, unknown> };
  /** The agent's last prose, which is all you get when it ended without a signal. */
  text: string;
  turns: number;
  error?: string;
}

/**
 * One agent's turn loop.
 *
 * A manual loop rather than the SDK tool runner, for three reasons that all
 * matter here: the budget must be consulted before each model call and charged
 * after it, the kill switch must be honoured between every step, and the same
 * loop has to drive Anthropic, OpenAI, Gemini and CLI agents through one
 * normalised provider interface.
 */
export class Agent {
  private readonly log;

  constructor(
    readonly spec: AgentSpec,
    private readonly provider: ModelProvider,
    private readonly tools: ToolRegistry,
    private readonly context: Omit<ToolContext, "agent" | "taskId" | "log">,
  ) {
    this.log = logger(`agent:${spec.id}`);
  }

  async run(assignment: Assignment): Promise<AgentOutcome> {
    const available = this.tools.forRole(this.spec.role);
    const system = systemPrompt(this.spec.role);
    const maxTurns = assignment.maxTurns ?? this.context.budget.limits.maxTurnsPerTask;

    const messages: Turn[] = [
      { role: "user", content: [{ type: "text", text: await this.openingTurn(assignment) }] },
    ];

    let lastText = "";
    let nudged = false;

    for (let turn = 1; turn <= maxTurns; turn++) {
      try {
        this.context.kill.assertLive();
        this.context.budget.check(this.spec.id);
      } catch (err) {
        if (err instanceof HaltedError) return { kind: "halted", text: err.reason, turns: turn - 1 };
        if (err instanceof BudgetExceededError) {
          return { kind: "budget", text: err.message, turns: turn - 1 };
        }
        throw err;
      }

      let result;
      try {
        result = await this.provider.complete(this.spec.model, {
          system,
          messages,
          tools: available.map((tool) => tool.spec),
          effort: effortFor(this.spec.role),
          maxTokens: 32_000,
          cwd: this.context.workspace,
        });
      } catch (err) {
        const message = err instanceof ProviderError ? err.message : String(err);
        this.log.error("model call failed", message);
        await this.context.ledger.record("error", this.spec.id, {
          stage: "model",
          error: message,
          taskId: assignment.taskId,
        });
        return { kind: "error", text: message, turns: turn, error: message };
      }

      this.context.budget.charge(this.spec.id, result.usage);
      await this.context.ledger.record("model.call", this.spec.id, {
        provider: this.provider.id,
        model: this.spec.model,
        turn,
        stopReason: result.stopReason,
        toolCalls: result.toolCalls.map((c) => c.name),
        usage: result.usage,
        taskId: assignment.taskId,
      });

      if (result.text.trim()) lastText = result.text;

      if (result.stopReason === "refusal") {
        return { kind: "error", text: result.text || "model declined the request", turns: turn };
      }

      const assistantTurn: Turn = {
        role: "assistant",
        content: [
          ...(result.text ? [{ type: "text" as const, text: result.text }] : []),
          ...result.toolCalls.map((c) => ({ type: "tool_call" as const, ...c })),
        ],
        ...(result.native ? { native: { provider: this.provider.id, blocks: result.native } } : {}),
      };
      messages.push(assistantTurn);

      if (result.toolCalls.length === 0) {
        // No tool calls and no signal: the agent believes it is done but never
        // said so through a tool. Nudge once, then take its prose as the answer.
        //
        // Once, and once only. This nudged on every remaining turn, and an
        // architect that had already said its piece simply said it again: five
        // more identical calls, a third of the run's spend, and the same plan
        // adopted at the end that was there after the first reply. A model that
        // answers the nudge with the same answer is not going to change it.
        if (turn < maxTurns && !nudged) {
          // The nudge comes once, so it carries the turn budget with it. An
          // agent that answers in prose gets no second reminder, and nothing
          // may run out of turns without having been told - a reviewer that
          // spent its last turn mid-inquiry is why that rule exists.
          const text = [
            this.noSignalNudge(),
            "This is your only reminder. Reply again without calling a tool and " +
              "your prose is taken as your final answer.",
            this.lastCallWarning(maxTurns - turn),
          ].join("\n\n");
          messages.push({ role: "user", content: [{ type: "text", text }] });
          nudged = true;
          continue;
        }
        return { kind: "text", text: lastText, turns: turn };
      }

      // Progress: a later turn that stops talking may be nudged again.
      nudged = false;

      const parts: ContentPart[] = [];
      let signal: AgentOutcome["signal"] | undefined;

      for (const call of result.toolCalls) {
        const outcome = await this.invoke(call.name, call.input, assignment.taskId);
        parts.push({
          type: "tool_result",
          callId: call.id,
          content: truncate(outcome.content, 40_000),
          ...(outcome.isError ? { isError: true } : {}),
        });
        if (outcome.signal && !signal) signal = outcome.signal;
      }

      if (signal) {
        return { kind: "signal", signal, text: lastText, turns: turn };
      }

      const inbox = await this.drainInbox();
      if (inbox) parts.push({ type: "text", text: inbox });

      // Tell an agent when it is running out of turns. Without this it cannot
      // budget: a reviewer verifying carefully would spend its last turn
      // mid-investigation and never render a verdict, and the work it had
      // actually approved of was sent back as unreviewed.
      const remaining = maxTurns - turn;
      if (remaining <= 2) parts.push({ type: "text", text: this.lastCallWarning(remaining) });

      messages.push({ role: "user", content: parts });
    }

    return { kind: "turn_limit", text: lastText, turns: maxTurns };
  }

  /** Run one tool, with the policy gate in front of it. */
  private async invoke(
    name: string,
    input: Record<string, unknown>,
    taskId: string | undefined,
  ): Promise<{ content: string; isError?: boolean; signal?: AgentOutcome["signal"] }> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { content: `no such tool "${name}"`, isError: true };
    }
    if (!this.tools.forRole(this.spec.role).some((t) => t.spec.name === name)) {
      return { content: `tool "${name}" is not available to a ${this.spec.role}`, isError: true };
    }

    if (tool.capability) {
      const decision = this.context.policy.evaluate(this.spec, tool.capability);
      if (!decision.allow) {
        await this.context.ledger.record("tool.denied", this.spec.id, {
          tool: name,
          capability: tool.capability,
          reason: decision.reason,
          taskId,
        });
        return {
          content:
            `denied: ${decision.reason}\n` +
            `You cannot obtain this capability during the run. Achieve the goal another way, ` +
            `or call block_task explaining what the run would need.`,
          isError: true,
        };
      }
    }

    try {
      this.context.kill.assertLive();
      const result = await tool.run(input, {
        ...this.context,
        agent: this.spec,
        taskId,
        log: this.log,
      });
      return result;
    } catch (err) {
      if (err instanceof HaltedError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      await this.context.ledger.record("error", this.spec.id, { stage: "tool", tool: name, error: message });
      return { content: `tool ${name} failed: ${message}`, isError: true };
    }
  }

  /** The first user turn: instruction, then everything the agent needs to know. */
  private async openingTurn(assignment: Assignment): Promise<string> {
    const sections = [
      `# Your assignment\n${assignment.instruction}`,
      assignment.context ? `# Context\n${assignment.context}` : null,
      `# Work graph\n${this.context.tasks.render()}`,
      `# Blackboard\n${await this.context.board.render()}`,
      `# Your inbox\n${renderInbox(await this.freshInbox())}`,
      `# Your identity\nagent id: ${this.spec.id}\nrole: ${this.spec.role}\nmodel: ${this.provider.id}/${this.spec.model}`,
    ];
    return sections.filter((s): s is string => s !== null).join("\n\n");
  }

  private async freshInbox() {
    const messages = await this.context.bus.inbox(this.spec.id, this.spec.role);
    await this.context.bus.markRead(this.spec.id, messages);
    return messages;
  }

  /** Mid-loop inbox delivery, appended to tool results so it costs no extra call. */
  private async drainInbox(): Promise<string | null> {
    const messages = await this.freshInbox();
    if (messages.length === 0) return null;
    return `# New messages\n${renderInbox(messages)}`;
  }

  /** Told to an agent with almost no turns left, so it can still conclude. */
  private lastCallWarning(remaining: number): string {
    const finisher =
      this.spec.role === "reviewer"
        ? "submit_review with your verdict"
        : this.spec.role === "architect"
          ? "the plan JSON"
          : "complete_task, or block_task if you cannot proceed";
    return (
      `# Turn budget\n` +
      `You have ${remaining} turn${remaining === 1 ? "" : "s"} left. ` +
      `Stop investigating and finish now: return ${finisher} on this turn, ` +
      `based on what you already know. Ending without it means your work is ` +
      `discarded and the task is treated as unfinished.`
    );
  }

  private noSignalNudge(): string {
    switch (this.spec.role) {
      case "reviewer":
        return "You have not recorded a verdict. Call submit_review now with approve or request_changes.";
      case "architect":
        return "Reply with the plan as a single JSON object and nothing else.";
      default:
        return (
          "You ended your turn without calling a tool. If the work is finished, call complete_task. " +
          "If you cannot proceed, call block_task. If neither is true, continue working."
        );
    }
  }
}
