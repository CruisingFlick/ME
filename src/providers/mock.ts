import { ZERO_USAGE } from "../types.js";
import type {
  CompletionRequest,
  CompletionResult,
  ModelProvider,
  ToolCall,
} from "./types.js";

export type MockHandler = (
  request: CompletionRequest,
  callIndex: number,
) => CompletionResult;

/**
 * A provider that never touches the network.
 *
 * This exists so the orchestration itself can be tested and demonstrated: the
 * interesting failure modes of a swarm - deadlocked dependencies, a review loop
 * that never converges, a budget that runs out mid-integration - are properties
 * of the coordination, not of any model, and they should be reproducible.
 */
export class MockProvider implements ModelProvider {
  readonly id = "mock";
  readonly defaultModel = "mock-1";
  private calls = 0;
  readonly seen: CompletionRequest[] = [];

  constructor(private readonly handler: MockHandler = defaultHandler) {}

  available(): boolean {
    return true;
  }

  unavailableReason(): string | null {
    return null;
  }

  async complete(_model: string, request: CompletionRequest): Promise<CompletionResult> {
    this.seen.push(request);
    return this.handler(request, this.calls++);
  }
}

export function reply(text: string, toolCalls: ToolCall[] = []): CompletionResult {
  return {
    text,
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tool_use" : "end",
    usage: { ...ZERO_USAGE, inputTokens: 100, outputTokens: 50, costUsd: 0.001 },
  };
}

let counter = 0;
export function call(name: string, input: Record<string, unknown>): ToolCall {
  return { id: `mock_call_${counter++}`, name, input };
}

/**
 * Plays a plausible member of the swarm well enough to drive the whole pipeline
 * end to end: plan, write files, review, approve.
 */
function defaultHandler(request: CompletionRequest, _callIndex: number): CompletionResult {
  const system = request.system;
  const has = (tool: string) => request.tools.some((t) => t.name === tool);
  const usedAlready = (tool: string) =>
    request.messages.some((turn) =>
      turn.content.some((part) => part.type === "tool_call" && part.name === tool),
    );

  if (system.includes("ROLE: architect")) {
    return reply(
      JSON.stringify({
        summary: "Mock plan: a single-service app with one build step.",
        stack: { runtime: "node", framework: "express", database: "neon-postgres" },
        tasks: [
          {
            id: "t1",
            title: "Implement the service entrypoint",
            brief: "Create src/server.js exposing GET /health returning {ok:true}.",
            paths: ["src/server.js"],
            dependsOn: [],
            role: "builder",
          },
          {
            id: "t2",
            title: "Add a smoke test",
            brief: "Create test/health.test.js asserting the health route responds.",
            paths: ["test/health.test.js"],
            dependsOn: ["t1"],
            role: "builder",
          },
        ],
        integrations: ["github", "neon", "railway"],
      }),
    );
  }

  if (system.includes("ROLE: builder")) {
    if (has("write_file") && !usedAlready("write_file")) {
      return reply("Writing the file.", [
        call("write_file", {
          path: "src/server.js",
          content:
            "export function health() {\n  return { ok: true };\n}\n",
        }),
      ]);
    }
    if (has("complete_task") && !usedAlready("complete_task")) {
      return reply("Done.", [
        call("complete_task", { summary: "Added the health handler." }),
      ]);
    }
    return reply("Nothing further.");
  }

  if (system.includes("ROLE: integrator") || system.includes("ROLE: operator")) {
    if (has("board_write") && !usedAlready("board_write")) {
      return reply("Publishing the runbook.", [
        call("board_write", {
          key: system.includes("ROLE: integrator") ? "project.runbook" : "ship.result",
          value: JSON.stringify({ build: "npm ci && npm run build", test: "npm test" }),
        }),
      ]);
    }
    if (has("complete_task") && !usedAlready("complete_task")) {
      return reply("Done.", [
        call("complete_task", { summary: "Build and tests are green; runbook published." }),
      ]);
    }
    return reply("Nothing further.");
  }

  if (system.includes("ROLE: reviewer")) {
    if (has("submit_review") && !usedAlready("submit_review")) {
      return reply("Reviewed.", [
        call("submit_review", {
          verdict: "approve",
          summary: "Matches the brief; no blocking issues.",
        }),
      ]);
    }
    return reply("Already reviewed.");
  }

  return reply("(mock) acknowledged.");
}
