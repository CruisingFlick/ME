import { relative, resolve } from "node:path";
import type { AgentSpec, Capability } from "../types.js";

export interface PolicyDecision {
  allow: boolean;
  reason: string;
}

export interface PolicyOptions {
  /** Capabilities the whole run is permitted to exercise. */
  runGrants: Set<Capability>;
  /** Absolute path every filesystem write must stay inside. */
  workspace: string;
}

/**
 * Commands that are never worth the risk of an unattended agent getting them
 * subtly wrong. These are refused regardless of capability grants: a swarm that
 * needs `rm -rf /` has already made a mistake somewhere upstream.
 */
const FORBIDDEN_SHELL: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+\/(\s|$)/i, why: "recursive delete of the filesystem root" },
  { pattern: /\bmkfs(\.|\s)/i, why: "filesystem format" },
  { pattern: /\bdd\s+[^|]*of=\/dev\//i, why: "raw write to a block device" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;?\s*:/, why: "fork bomb" },
  { pattern: /\bshutdown\b|\breboot\b|\bhalt\b/i, why: "host power control" },
  { pattern: /\bgit\s+push\b[^\n]*--force(?!-with-lease)/i, why: "non-lease force push (history loss)" },
  { pattern: /\bgit\s+(reset\s+--hard\s+origin|clean\s+-[a-z]*f[a-z]*d)/i, why: "destructive working-tree reset" },
  { pattern: /\bDROP\s+(DATABASE|SCHEMA)\b/i, why: "database drop" },
  { pattern: /\bTRUNCATE\s+TABLE\b/i, why: "table truncate" },
  { pattern: /\bcurl\b[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/i, why: "pipe-to-shell of remote code" },
  { pattern: /\bsudo\b/i, why: "privilege escalation" },
  { pattern: /\b(ANTHROPIC|OPENAI|GEMINI|GITHUB|NEON|RAILWAY|CLERK|RESEND)_[A-Z_]*(KEY|TOKEN|SECRET)\b[^\n]*\b(curl|wget|nc)\b/i, why: "credential exfiltration" },
];

/**
 * Decides whether a side effect may happen.
 *
 * Because there is no human to ask, the answer has to come from grants written
 * down before the run started, not from the agent's own judgement mid-run.
 */
export class PolicyEngine {
  constructor(private readonly options: PolicyOptions) {}

  /** Is this capability available to this agent in this run? */
  evaluate(agent: AgentSpec, capability: Capability): PolicyDecision {
    if (!this.options.runGrants.has(capability)) {
      return {
        allow: false,
        reason: `capability "${capability}" is not granted to this run (add it to HIVE_GRANTS to enable)`,
      };
    }
    if (!agent.capabilities.includes(capability)) {
      return {
        allow: false,
        reason: `agent ${agent.id} (${agent.role}) does not hold "${capability}"`,
      };
    }
    return { allow: true, reason: "granted" };
  }

  /** Second gate for shell: the command text itself. */
  inspectCommand(command: string): PolicyDecision {
    for (const rule of FORBIDDEN_SHELL) {
      if (rule.pattern.test(command)) {
        return { allow: false, reason: `refused (${rule.why}): ${command.slice(0, 160)}` };
      }
    }
    return { allow: true, reason: "no forbidden pattern matched" };
  }

  /**
   * Confine a path to the workspace. Resolves symlink-free lexical paths, so a
   * builder cannot reach the host's home directory by way of `../../..`.
   */
  resolveInWorkspace(candidate: string): { path: string } | PolicyDecision {
    const abs = resolve(this.options.workspace, candidate);
    const rel = relative(this.options.workspace, abs);
    if (rel.startsWith("..") || resolve(abs) === resolve(this.options.workspace, "..")) {
      return { allow: false, reason: `path "${candidate}" escapes the workspace` };
    }
    return { path: abs };
  }

  get workspace(): string {
    return this.options.workspace;
  }
}

export function isDecision(value: unknown): value is PolicyDecision {
  return typeof value === "object" && value !== null && "allow" in value;
}
