import type { Role } from "../types.js";
import { listFilesTool, readFileTool, writeFileTool } from "./fs.js";
import {
  addTaskTool,
  blockTaskTool,
  boardReadTool,
  boardWriteTool,
  completeTaskTool,
  sendMessageTool,
  submitReviewTool,
} from "./collab.js";
import {
  clerkProvisionTool,
  githubPullRequestTool,
  githubPushTool,
  neonBranchTool,
  railwayDeployTool,
  railwayVariablesTool,
  resendNotifyTool,
} from "./integrations.js";
import { runCommandTool } from "./shell.js";
import type { HiveTool } from "./types.js";

const ALL: HiveTool[] = [
  readFileTool,
  writeFileTool,
  listFilesTool,
  runCommandTool,
  sendMessageTool,
  boardWriteTool,
  boardReadTool,
  addTaskTool,
  completeTaskTool,
  blockTaskTool,
  submitReviewTool,
  githubPushTool,
  githubPullRequestTool,
  neonBranchTool,
  railwayVariablesTool,
  railwayDeployTool,
  clerkProvisionTool,
  resendNotifyTool,
];

/**
 * Which tools each role may even see.
 *
 * This is narrower than the capability check on purpose. Capabilities decide
 * whether an action is permitted; this decides whether the model is told the
 * action exists. A builder that is never shown railway_deploy will not spend a
 * turn reasoning about whether to deploy - the cheapest guardrail is the one
 * that keeps the option out of the context window entirely.
 */
const BY_ROLE: Record<Role, string[]> = {
  architect: ["read_file", "list_files", "board_write", "board_read", "send_message", "add_task"],
  builder: [
    "read_file",
    "write_file",
    "list_files",
    "run_command",
    "board_read",
    "board_write",
    "send_message",
    "complete_task",
    "block_task",
  ],
  reviewer: [
    "read_file",
    "list_files",
    "run_command",
    "board_read",
    "send_message",
    "submit_review",
  ],
  integrator: [
    "read_file",
    "write_file",
    "list_files",
    "run_command",
    "board_read",
    "board_write",
    "send_message",
    "add_task",
    "complete_task",
    "block_task",
    "github_push_files",
    "github_open_pull_request",
  ],
  operator: [
    "read_file",
    "list_files",
    "run_command",
    "board_read",
    "board_write",
    "send_message",
    "complete_task",
    "block_task",
    "github_push_files",
    "github_open_pull_request",
    "neon_create_branch",
    "railway_set_variables",
    "railway_deploy",
    "clerk_create_jwt_template",
    "resend_send_email",
  ],
};

export class ToolRegistry {
  private readonly tools = new Map<string, HiveTool>();

  constructor(tools: HiveTool[] = ALL) {
    for (const tool of tools) this.tools.set(tool.spec.name, tool);
  }

  get(name: string): HiveTool | undefined {
    return this.tools.get(name);
  }

  forRole(role: Role): HiveTool[] {
    return (BY_ROLE[role] ?? [])
      .map((name) => this.tools.get(name))
      .filter((tool): tool is HiveTool => tool !== undefined);
  }

  /** Capabilities a role needs to use everything it can see. */
  capabilitiesForRole(role: Role) {
    const capabilities = this.forRole(role)
      .map((tool) => tool.capability)
      .filter((cap): cap is NonNullable<typeof cap> => cap !== null);
    return [...new Set(capabilities)];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }
}
