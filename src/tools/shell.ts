import { spawn } from "node:child_process";
import { truncate } from "../util/json.js";
import { fail, ok, str, type HiveTool } from "./types.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Shell access inside the workspace.
 *
 * Two gates apply before anything runs: the shell:exec capability, and a
 * command-text inspection in the policy engine. The second gate exists because
 * a capability grant is coarse - "may run commands" should still not mean "may
 * run `sudo rm -rf /`" when there is nobody watching the terminal.
 */
export const runCommandTool: HiveTool = {
  capability: "shell:exec",
  spec: {
    name: "run_command",
    description:
      "Run a shell command in the workspace root and return its stdout, stderr and exit code. Use this for installs, builds, tests and git. Long output is truncated.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to run" },
        timeout_seconds: {
          type: "number",
          description: "Kill the command after this many seconds (default 300, max 900)",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  async run(input, context) {
    const command = str(input, "command");
    const verdict = context.policy.inspectCommand(command);
    if (!verdict.allow) {
      await context.ledger.record("tool.denied", context.agent.id, {
        tool: "run_command",
        command: command.slice(0, 300),
        reason: verdict.reason,
      });
      return fail(
        `${verdict.reason}\nThis is a hard policy rule, not a permission you can request. Find another way to achieve the goal.`,
      );
    }

    const seconds = typeof input.timeout_seconds === "number" ? input.timeout_seconds : 300;
    const timeoutMs = Math.min(Math.max(seconds, 1) * 1000, DEFAULT_TIMEOUT_MS * 3);

    const started = Date.now();
    const result = await exec(command, context.workspace, timeoutMs);
    const elapsed = Date.now() - started;

    await context.ledger.record("tool.call", context.agent.id, {
      tool: "run_command",
      command: command.slice(0, 300),
      exitCode: result.code,
      ms: elapsed,
      taskId: context.taskId,
    });

    const body =
      `exit code: ${result.code} (${Math.round(elapsed / 1000)}s)\n` +
      `--- stdout ---\n${truncate(result.stdout, 20_000)}\n` +
      `--- stderr ---\n${truncate(result.stderr, 8_000)}`;

    // A non-zero exit is information, not a tool failure: the agent is expected
    // to read the output and fix the cause.
    return ok(body);
  },
};

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

function exec(command: string, cwd: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: {
        ...process.env,
        // Keep provider credentials out of the reach of generated build scripts.
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        GEMINI_API_KEY: "",
        GITHUB_TOKEN: "",
        NEON_API_KEY: "",
        RAILWAY_TOKEN: "",
        CLERK_SECRET_KEY: "",
        RESEND_API_KEY: "",
        CI: "1",
      },
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err), code: 127 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: killed ? stderr + `\n[killed after ${timeoutMs}ms]` : stderr,
        code: killed ? 124 : code ?? 1,
      });
    });
  });
}
