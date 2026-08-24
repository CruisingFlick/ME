import { parseJsonLoose } from "../util/json.js";
import { fail, ok, str, strArray, type HiveTool } from "./types.js";

/**
 * The tools that make this a swarm rather than a queue of independent jobs:
 * addressed messages, a shared blackboard, and the ability to reshape the work
 * graph while the run is in flight.
 */

export const sendMessageTool: HiveTool = {
  capability: "bus:send",
  spec: {
    name: "send_message",
    description:
      "Send a message to another agent. Address it to an agent id (e.g. builder-1), a role name (architect, builder, reviewer, integrator, operator) to reach everyone in that role, or * for all. Use this to ask for a decision, hand off context, or flag something that affects another agent's task. It is asynchronous: the recipient sees it on their next turn. Do not wait for a reply - if you are blocked, call block_task instead.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Agent id, role name, or *" },
        subject: { type: "string", description: "One line summarising the point" },
        body: { type: "string", description: "The full message" },
        kind: {
          type: "string",
          enum: ["request", "response", "broadcast", "review", "blocker", "handoff"],
        },
        thread_id: {
          type: "string",
          description: "Reply into an existing thread by passing its id",
        },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
  },
  async run(input, context) {
    const message = await context.bus.send({
      from: context.agent.id,
      to: str(input, "to"),
      subject: str(input, "subject"),
      body: str(input, "body"),
      kind: (input.kind as never) ?? "request",
      threadId: typeof input.thread_id === "string" ? input.thread_id : undefined,
      taskId: context.taskId,
    });
    return ok(`sent ${message.id} to ${message.to} (thread ${message.threadId})`);
  },
};

export const boardWriteTool: HiveTool = {
  capability: "board:write",
  spec: {
    name: "board_write",
    description:
      "Publish a decision or fact to the shared blackboard under a stable key, so every other agent can rely on it without asking. Use it for things that must not be re-derived: chosen stack, database schema, API contract, environment variable names, deploy URLs. Overwriting an existing key is allowed and versioned.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Stable key, e.g. api.contract or db.schema" },
        value: { type: "string", description: "The content; JSON is parsed, anything else is stored as text" },
      },
      required: ["key", "value"],
      additionalProperties: false,
    },
  },
  async run(input, context) {
    const key = str(input, "key");
    const raw = str(input, "value");
    let value: unknown = raw;
    try {
      value = parseJsonLoose(raw);
    } catch {
      // plain text is a perfectly good blackboard value
    }
    const entry = await context.board.put(key, value, context.agent.id);
    return ok(`published ${key} (v${entry.version})`);
  },
};

export const boardReadTool: HiveTool = {
  capability: null,
  spec: {
    name: "board_read",
    description:
      "Read one blackboard key in full. The prompt already includes a truncated view of every key; use this when you need the complete value.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
  },
  async run(input, context) {
    const entry = await context.board.get(str(input, "key"));
    if (!entry) return fail(`no blackboard entry for "${str(input, "key")}"`);
    const text = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value, null, 2);
    return ok(`# ${entry.key} (v${entry.version}, by ${entry.author})\n${text}`);
  },
};

export const addTaskTool: HiveTool = {
  capability: "task:manage",
  spec: {
    name: "add_task",
    description:
      "Add a task to the work graph. Use this when you discover work the plan missed. Anything listed in depends_on must finish before this task starts.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        brief: {
          type: "string",
          description: "Everything the assignee needs; they will not see this conversation",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Files this task is expected to own",
        },
        depends_on: { type: "array", items: { type: "string" } },
        role: { type: "string", enum: ["builder", "reviewer", "integrator", "operator"] },
      },
      required: ["title", "brief"],
      additionalProperties: false,
    },
  },
  async run(input, context) {
    const dependsOn = strArray(input, "depends_on");
    const unknown = dependsOn.filter((dep) => !context.tasks.has(dep));
    if (unknown.length > 0) {
      return fail(`unknown task ids in depends_on: ${unknown.join(", ")}`);
    }
    const task = await context.tasks.add({
      title: str(input, "title"),
      brief: str(input, "brief"),
      paths: strArray(input, "paths"),
      dependsOn,
      role: (input.role as never) ?? "builder",
    });
    // A new task must not introduce a cycle; roll it back rather than deadlock.
    const cycles = context.tasks.cycles();
    if (cycles.length > 0) {
      await context.tasks.update(task.id, { status: "abandoned" }, context.agent.id);
      return fail(
        `that task would create a dependency cycle (${cycles[0]?.join(" -> ")}); it has been discarded`,
      );
    }
    return ok(`created ${task.id}: ${task.title}`);
  },
};

export const completeTaskTool: HiveTool = {
  capability: null,
  spec: {
    name: "complete_task",
    description:
      "Declare your assigned task finished and hand it to review. Call this only once the work is actually on disk and any build or test you were asked to run passes. This ends your turn.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "What you changed and why, for the reviewer",
        },
        files_changed: { type: "array", items: { type: "string" } },
        no_changes_needed: {
          type: "boolean",
          description:
            "Set true only if the task was genuinely satisfied without editing any file - for example the work was already present and correct. Your summary must then say how you established that. A reviewer checks the claim.",
        },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  async run(input, _context) {
    return ok("task submitted for review", {
      name: "complete_task",
      payload: {
        summary: str(input, "summary"),
        filesChanged: strArray(input, "files_changed"),
        noChangesNeeded: input.no_changes_needed === true,
      },
    });
  },
};

export const blockTaskTool: HiveTool = {
  capability: null,
  spec: {
    name: "block_task",
    description:
      "Stop work and report that your task cannot proceed. Use this rather than guessing or inventing a substitute when something you depend on is missing, contradictory, or outside your capabilities. This ends your turn.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Precisely what is blocking you" },
        needs: {
          type: "string",
          description: "What would unblock it - a decision, a credential, another task",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  async run(input, _context) {
    return ok("task reported as blocked", {
      name: "block_task",
      payload: { reason: str(input, "reason"), needs: str(input, "needs", "") },
    });
  },
};

export const submitReviewTool: HiveTool = {
  capability: null,
  spec: {
    name: "submit_review",
    description:
      "Record your verdict on the work under review. Approve only if it satisfies the brief and you found no correctness problem. Request changes with specific, actionable findings - the builder sees your summary verbatim and nothing else. This ends your turn.",
    inputSchema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["approve", "request_changes"] },
        summary: {
          type: "string",
          description: "Findings, each with the file and what to do about it",
        },
      },
      required: ["verdict", "summary"],
      additionalProperties: false,
    },
  },
  async run(input, _context) {
    const verdict = str(input, "verdict");
    if (verdict !== "approve" && verdict !== "request_changes") {
      return fail('verdict must be "approve" or "request_changes"');
    }
    return ok(`review recorded: ${verdict}`, {
      name: "submit_review",
      payload: { verdict, summary: str(input, "summary") },
    });
  },
};
