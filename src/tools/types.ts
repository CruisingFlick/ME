import type { Blackboard } from "../kernel/blackboard.js";
import type { Budget } from "../kernel/budget.js";
import type { MessageBus } from "../kernel/bus.js";
import type { KillSwitch } from "../kernel/killswitch.js";
import type { Ledger } from "../kernel/ledger.js";
import type { PolicyEngine } from "../kernel/policy.js";
import type { TaskGraph } from "../kernel/tasks.js";
import type { Integrations } from "../integrations/index.js";
import type { ToolSpec } from "../providers/types.js";
import type { AgentSpec, Capability } from "../types.js";
import type { Logger } from "../util/log.js";

export interface ToolContext {
  runId: string;
  agent: AgentSpec;
  /** The task this agent is currently working, when it has one. */
  taskId?: string;
  workspace: string;
  bus: MessageBus;
  board: Blackboard;
  tasks: TaskGraph;
  ledger: Ledger;
  policy: PolicyEngine;
  budget: Budget;
  kill: KillSwitch;
  integrations: Integrations;
  log: Logger;
}

/**
 * A tool's answer to the model, plus optional control flow for the agent loop.
 *
 * `signal` is how a tool ends a turn deliberately - a builder calling
 * complete_task, a reviewer submitting a verdict - rather than the loop having
 * to guess from prose that the agent thinks it is finished.
 */
export interface ToolResult {
  content: string;
  isError?: boolean;
  signal?: { name: string; payload: Record<string, unknown> };
}

export interface HiveTool {
  spec: ToolSpec;
  /** Capability required to run this tool; null for read-only, side-effect-free tools. */
  capability: Capability | null;
  run(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export function ok(content: string, signal?: ToolResult["signal"]): ToolResult {
  return signal ? { content, signal } : { content };
}

export function fail(content: string): ToolResult {
  return { content, isError: true };
}

/** Small helpers so every tool validates its input the same way. */
export function str(input: Record<string, unknown>, key: string, fallback?: string): string {
  const value = input[key];
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`"${key}" must be a string`);
}

export function strArray(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}
