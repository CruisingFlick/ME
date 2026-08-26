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

/**
 * Run a command, and always come back.
 *
 * Two things make that harder than it looks, and both were wrong here.
 *
 * With `shell: true` the child is a shell, so killing it leaves anything it
 * started running - a builder that runs a dev server orphans a process holding
 * the inherited stdout pipe.
 *
 * And because that pipe stays open, `close` never fires. The old code resolved
 * only on `close`, so the timeout would kill a process and then wait forever
 * for an event that could not arrive: a run that hung with no error, no report
 * and nothing in the ledger. The timeout now settles the promise itself.
 */
function exec(command: string, cwd: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      // A process group of its own, so the whole tree can be signalled at once.
      detached: process.platform !== "win32",
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
        // The hive's own state database is not the built project's database.
        HIVE_DATABASE_URL: "",
        GH_TOKEN: "",
        CI: "1",
      },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // Settle on our own schedule rather than waiting for `close`, which an
      // orphan holding the pipe can withhold indefinitely. The grace period
      // lets a well-behaved process exit and report its real output first.
      // Settle on our own schedule if `close` does not arrive; when the tree
      // dies cleanly it usually arrives first, and the handler below reports
      // the same verdict.
      setTimeout(() => finish({ stdout, stderr: stderr + timeoutNote(), code: 124 }), 2000);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => finish({ stdout, stderr: stderr + String(err), code: 127 }));
    child.on("close", (code) =>
      finish(
        timedOut
          ? { stdout, stderr: stderr + timeoutNote(), code: 124 }
          : { stdout, stderr, code: code ?? 1 },
      ),
    );

    function timeoutNote(): string {
      return (
        `\n[no result after ${Math.round(timeoutMs / 1000)}s; the process tree was killed. ` +
        `A command that does not exit on its own - a dev server, a watch, an interactive ` +
        `prompt - cannot be used here.]`
      );
    }
  });
}

/**
 * Kill a process and everything it started.
 *
 * `child.kill()` reaches only the shell. Windows needs taskkill to walk the
 * tree; elsewhere the negative pid signals the whole process group, which is
 * why the child is spawned detached.
 */
function killTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL"); // the group may already be gone
  }
}
