/**
 * Core domain model for the hive.
 *
 * The vocabulary is deliberately small: a Run contains a DAG of Tasks, worked by
 * Agents, who communicate through Messages and share knowledge on the Blackboard.
 * Everything that happens is appended to the Ledger.
 */

export type RunStatus =
  | "planning"
  | "executing"
  | "reviewing"
  | "integrating"
  | "shipping"
  | "succeeded"
  | "failed"
  | "halted";

export type TaskStatus =
  | "pending"
  | "ready"
  | "in_progress"
  | "in_review"
  | "changes_requested"
  | "done"
  | "blocked"
  | "abandoned";

/**
 * Roles are behavioural contracts, not job titles. Each maps to a system prompt
 * and a tool allowlist (see agents/roles.ts).
 */
export type Role =
  | "architect"
  | "builder"
  | "reviewer"
  | "integrator"
  | "operator";

export interface Task {
  id: string;
  runId: string;
  title: string;
  /** Full natural-language statement of work handed to the builder. */
  brief: string;
  /** Files this task is expected to own. Used to detect write collisions. */
  paths: string[];
  dependsOn: string[];
  role: Role;
  status: TaskStatus;
  /** Agent currently holding the task, if any. */
  assignee?: string;
  /**
   * Review rounds this task has been through - times a reviewer judged the work
   * and asked for changes. Bounded by HIVE_MAX_REVIEW_ROUNDS.
   */
  reviewRounds: number;
  /**
   * Times this task has been dispatched at all, including rounds lost to
   * failures that were nothing to do with the work: a reviewer that ran out of
   * turns, a merge that no longer applied, a provider that could not
   * authenticate. Those must not spend the convergence budget, but they still
   * need a ceiling of their own or a task could be retried forever.
   */
  attempts: number;
  /** Latest reviewer feedback, fed back to the builder verbatim. */
  feedback?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSpec {
  /** Stable address used by the message bus, e.g. "builder-2". */
  id: string;
  role: Role;
  /** Provider id from the provider registry, e.g. "anthropic". */
  provider: string;
  model: string;
  /** Capabilities this agent may exercise; enforced by the policy engine. */
  capabilities: Capability[];
}

/**
 * Capabilities gate every side effect. A tool declares the capability it needs;
 * the policy engine checks it against the agent's grant and the run's policy
 * before the tool is allowed to run.
 */
export type Capability =
  | "fs:read"
  | "fs:write"
  | "shell:exec"
  | "net:read"
  | "bus:send"
  | "board:write"
  | "task:manage"
  | "github:read"
  | "github:write"
  | "db:read"
  | "db:write"
  | "db:destructive"
  | "deploy:preview"
  | "deploy:production"
  | "email:send"
  | "auth:admin";

export type MessageKind =
  | "request"
  | "response"
  | "broadcast"
  | "review"
  | "blocker"
  | "handoff";

export interface Message {
  id: string;
  runId: string;
  from: string;
  /** Agent id, a role name (fans out to that role), or "*" for everyone. */
  to: string;
  kind: MessageKind;
  subject: string;
  body: string;
  /** Groups a request with its responses. */
  threadId: string;
  taskId?: string;
  createdAt: string;
  readBy: string[];
}

/** A durable, typed fact agents publish for each other. */
export interface BoardEntry {
  key: string;
  runId: string;
  value: unknown;
  author: string;
  /** Monotonic; increments on every overwrite so agents can detect staleness. */
  version: number;
  updatedAt: string;
}

export type LedgerEventType =
  | "run.started"
  | "run.phase"
  | "run.finished"
  | "agent.turn"
  | "model.call"
  | "tool.call"
  | "tool.denied"
  | "message.sent"
  | "board.write"
  | "task.status"
  | "budget.charge"
  | "budget.exceeded"
  | "policy.decision"
  | "killswitch.tripped"
  | "integration.call"
  | "error";

export interface LedgerEvent {
  id: string;
  runId: string;
  type: LedgerEventType;
  actor: string;
  at: string;
  data: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
}

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  costUsd: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}
