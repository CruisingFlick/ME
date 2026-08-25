import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { parseJsonLoose, truncate } from "../util/json.js";
import { logger } from "../util/log.js";
import {
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
  type ModelProvider,
  type ToolCall,
  type ToolSpec,
} from "./types.js";

const log = logger("provider:claude-cli");

/** The agent must end its output with this marker followed by a JSON verdict. */
const MARKER = "<<<HIVE_RESULT>>>";

/**
 * Map hive tools onto the CLI's own tool names.
 *
 * A CLI agent cannot call hive tools - it has its own harness - so the closest
 * we get to a capability grant is restricting which of *its* tools it may use.
 * Tools with no equivalent (the bus, the blackboard) are simply unavailable to
 * a CLI-backed agent, which is why they are told to put everything that matters
 * into their final report instead.
 */
const TOOL_MAP: Record<string, string[]> = {
  read_file: ["Read"],
  list_files: ["Glob", "Grep"],
  write_file: ["Write", "Edit"],
  run_command: ["Bash"],
};

/**
 * Drives the locally installed `claude` CLI as a full member of the swarm.
 *
 * The other providers hand back tool calls for the hive to execute. This one
 * runs its own tool loop in its own process, so the deal is different: it is
 * given a worktree and a restricted tool set, it does the work itself, and it
 * reports back through a structured verdict the hive parses into the same
 * control signal a tool call would have produced.
 *
 * The tradeoff is explicit. The hive cannot inspect individual commands this
 * agent runs, so the policy engine's command rules do not apply inside it.
 * What still holds: it runs in the task's own worktree, it only gets the CLI
 * tools its role maps to, and its spend is real and accounted for.
 */
export class ClaudeCliProvider implements ModelProvider {
  readonly id = "claude-code";
  readonly defaultModel = process.env.HIVE_CLAUDE_CLI_MODEL ?? "sonnet";
  private readonly binary = "claude";

  available(): boolean {
    return which(this.binary) !== null;
  }

  unavailableReason(): string | null {
    return this.available() ? null : "the claude CLI is not on PATH";
  }

  async verify(): Promise<string> {
    const path = which(this.binary);
    if (!path) throw new Error("the claude CLI is not on PATH");
    const version = await run(this.binary, ["--version"], null, 30_000);
    if (version.code !== 0) {
      throw new Error(`claude --version exited ${version.code}: ${version.stderr.slice(0, 200)}`);
    }
    return `${path} (${version.stdout.trim()}), model ${this.defaultModel}`;
  }

  async complete(model: string, request: CompletionRequest): Promise<CompletionResult> {
    const signalTools = request.tools.filter((tool) => SIGNAL_TOOLS.has(tool.name));
    const prompt = renderPrompt(request, signalTools);
    const allowed = allowedToolsFor(request.tools);

    // The prompt goes on stdin, not in argv. A reviewer's prompt carries the
    // whole diff plus the blackboard, and an argument list has a hard size
    // limit that a large task would eventually cross - as an exec failure that
    // looks nothing like the cause.
    const args = [
      "-p",
      "--output-format",
      "json",
      // Edits are pre-approved; nothing else is. There is nobody to answer a
      // permission prompt, so an un-approved tool must fail rather than hang.
      "--permission-mode",
      "acceptEdits",
      "--max-turns",
      String(process.env.HIVE_CLAUDE_CLI_MAX_TURNS ?? 40),
      "--model",
      model,
      ...(allowed.length > 0 ? ["--allowedTools", ...allowed] : []),
    ];

    const result = await run(this.binary, args, prompt, 25 * 60 * 1000, request.cwd);
    if (result.code !== 0 && !result.stdout.trim().startsWith("{")) {
      throw new ProviderError(
        `claude exited ${result.code}: ${truncate(result.stderr || result.stdout, 500)}`,
        this.id,
        result.code === 124,
      );
    }

    let payload: CliResult;
    try {
      payload = parseJsonLoose<CliResult>(result.stdout);
    } catch {
      throw new ProviderError(
        `could not parse claude CLI output: ${truncate(result.stdout, 300)}`,
        this.id,
        false,
      );
    }

    if (payload.permission_denials?.length) {
      log.warn(`${payload.permission_denials.length} tool call(s) denied by the CLI's own policy`);
    }

    const text = payload.result ?? "";

    // A quota notice arrives as ordinary result text with a zero exit code, so
    // without this it looks like a successful answer: the orchestrator would
    // try to parse a rate-limit message as a plan, blame the model for bad
    // JSON, and retry against a quota that will not recover for hours.
    const limit = quotaMessage(text, payload);
    if (limit) throw new ProviderError(limit, this.id, false);

    const usage = payload.usage ?? {};
    const toolCalls = extractSignal(text, signalTools);

    return {
      text: stripMarker(text),
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_use" : payload.is_error ? "other" : "end",
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cachedInputTokens: usage.cache_read_input_tokens ?? 0,
        // The CLI reports what it actually spent, so this is measured rather
        // than estimated - unlike the token-table costing the API providers use.
        costUsd: payload.total_cost_usd ?? 0,
      },
    };
  }
}

/**
 * Recognise the CLI reporting that there is no quota left.
 *
 * Deliberately narrow: it must match a real limit notice and nothing an agent
 * might legitimately write about rate limiting while, say, building a rate
 * limiter.
 */
function quotaMessage(text: string, payload: CliResult): string | null {
  const trimmed = text.trim();
  const looksLikeLimit =
    /^(you'?ve|you have)\s+(hit|reached|exceeded)\s+your\s+(session|usage|weekly|rate)\s+limit/i.test(
      trimmed,
    ) ||
    /^claude usage limit reached/i.test(trimmed) ||
    /^rate[_ ]limit(_error)?\b/i.test(trimmed);

  // A short standalone notice, not a passing mention inside real work.
  if (looksLikeLimit && trimmed.length < 400) {
    return `claude CLI quota exhausted: ${trimmed}`;
  }
  if (payload.is_error && trimmed.length > 0 && trimmed.length < 400) {
    return `claude CLI reported an error: ${trimmed}`;
  }
  return null;
}

interface CliResult {
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  num_turns?: number;
  permission_denials?: unknown[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

const SIGNAL_TOOLS = new Set(["complete_task", "block_task", "submit_review"]);

function allowedToolsFor(tools: ToolSpec[]): string[] {
  const allowed = new Set<string>();
  for (const tool of tools) {
    for (const mapped of TOOL_MAP[tool.name] ?? []) allowed.add(mapped);
  }
  return [...allowed];
}

/**
 * Turn the swarm's tool-call protocol into something a CLI agent can satisfy:
 * do the work with your own tools, then declare the outcome in one JSON object.
 */
function renderPrompt(request: CompletionRequest, signalTools: ToolSpec[]): string {
  const transcript = request.messages
    .map((turn) => {
      const body = turn.content
        .map((part) => {
          if (part.type === "text") return part.text;
          if (part.type === "tool_call") return `[you called ${part.name}]`;
          return `[result] ${part.content}`;
        })
        .join("\n");
      return `### ${turn.role}\n${body}`;
    })
    .join("\n\n");

  // The protocol block goes before the transcript on purpose: the last thing an
  // agent reads should be its actual assignment, not the reporting format.
  const sections: string[] = [request.system];

  if (signalTools.length > 0) {
    const building = signalTools.some((tool) => tool.name === "complete_task");
    sections.push(
      [
        "## Do the work, then report",
        "",
        "You are an agent inside a larger swarm. The current directory is your own isolated",
        "checkout of the project. Use your own tools to do the work here: read the existing code,",
        "write the files, run the build and the tests.",
        "",
        ...(building
          ? [
              "Reporting completion is not completing. Your checkout is inspected after you finish:",
              "if you declare the task done and no file has changed, the report is rejected and the",
              "task is sent back to you, which wastes a round for nothing. Write the files first.",
              "",
            ]
          : []),
        `When - and only when - the work is actually done, end your output with ${MARKER} on its`,
        "own line, followed by exactly one JSON object and nothing after it:",
        "",
        ...signalTools.map((tool) => `- ${describeSignal(tool.name)}`),
        "",
        "That JSON is the only part of your output anyone reads. Omit it and your work is treated",
        "as unfinished, however much of it you did.",
      ].join("\n"),
    );
  }

  sections.push(transcript);
  return sections.filter(Boolean).join("\n\n");
}

function describeSignal(name: string): string {
  switch (name) {
    case "complete_task":
      return `finished the work: {"signal":"complete_task","summary":"what you changed and why, for the reviewer"}`;
    case "block_task":
      return `genuinely cannot proceed: {"signal":"block_task","reason":"what is blocking you","needs":"what would unblock it"}`;
    case "submit_review":
      return `reviewed the work: {"signal":"submit_review","verdict":"approve" or "request_changes","summary":"specific findings, each with the file and what to do"}`;
    default:
      return `{"signal":"${name}"}`;
  }
}

/** Recover the verdict from the agent's output and present it as a tool call. */
function extractSignal(text: string, signalTools: ToolSpec[]): ToolCall[] {
  const index = text.lastIndexOf(MARKER);
  const tail = index === -1 ? text : text.slice(index + MARKER.length);
  const permitted = new Set(signalTools.map((tool) => tool.name));

  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonLoose<Record<string, unknown>>(tail);
  } catch {
    if (index !== -1) log.warn("marker present but the verdict did not parse");
    return [];
  }

  const signal = typeof parsed.signal === "string" ? parsed.signal : null;
  if (!signal || !permitted.has(signal)) return [];

  const { signal: _dropped, ...input } = parsed;
  return [{ id: `cli_${signal}`, name: signal, input }];
}

function stripMarker(text: string): string {
  const index = text.lastIndexOf(MARKER);
  return (index === -1 ? text : text.slice(0, index)).trim();
}

function run(
  binary: string,
  args: string[],
  stdin: string | null,
  timeoutMs: number,
  cwd?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    // Node refuses to spawn a .cmd directly, so Windows needs a shell. This does
    // mean Node concatenates the arguments rather than escaping them (DEP0190),
    // which is tolerable only because every argument here is a constant or a
    // bare identifier - the prompt goes over stdin and never reaches argv.
    //
    // Invoking cmd.exe explicitly with an argument array would be cleaner and
    // silences the warning, but it killed the process outright on Windows and
    // cannot be reproduced on Linux CI. Correct-with-a-warning beats elegant
    // and broken; revisit only with a real Windows machine to test on.
    const executable = which(binary) ?? binary;
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      ...(cwd ? { cwd } : {}),
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: String(err), code: 127 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: killed ? 124 : code ?? 1 });
    });
    child.stdin.end(stdin ?? "");
  });
}

/**
 * Find an executable on PATH, the way the platform actually names them.
 *
 * On Windows an npm-installed CLI is `claude.cmd`, not `claude`, so looking for
 * the bare name finds nothing and the provider reports itself missing however
 * correctly it was installed.
 */
function which(binary: string): string | null {
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, binary + extension);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
