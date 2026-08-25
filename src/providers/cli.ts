import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { ZERO_USAGE } from "../types.js";
import { truncate } from "../util/json.js";
import {
  ProviderError,
  type CompletionRequest,
  type CompletionResult,
  type ModelProvider,
} from "./types.js";

export interface CliProviderOptions {
  id: string;
  /** Executable name, e.g. "claude", "codex", "gemini". */
  binary: string;
  /** Argument vector; "{PROMPT}" is replaced with the rendered prompt. */
  args: string[];
  /** Send the prompt on stdin instead of substituting it into args. */
  promptOnStdin?: boolean;
  timeoutMs?: number;
}

/**
 * Drives a locally installed coding-agent CLI as a one-shot consultant.
 *
 * Important limitation, and the reason this is a separate provider rather than
 * a peer of the API providers: a CLI agent runs its own tool loop inside its own
 * process. The hive cannot see or gate those tool calls, so a CLI-backed agent
 * gets no capability grants of its own - it is given text and returns text.
 * That makes it a good reviewer or second opinion, and a poor builder.
 */
export class CliProvider implements ModelProvider {
  readonly id: string;
  readonly defaultModel: string;

  constructor(private readonly options: CliProviderOptions) {
    this.id = options.id;
    this.defaultModel = options.binary;
  }

  available(): boolean {
    return which(this.options.binary) !== null;
  }

  unavailableReason(): string | null {
    return this.available() ? null : `${this.options.binary} is not on PATH`;
  }

  async verify(): Promise<string> {
    const path = which(this.options.binary);
    if (!path) throw new Error(`${this.options.binary} is not on PATH`);
    // Its own auth state is the CLI's business; all we can prove is that it runs.
    const { code, stdout, stderr } = await run(this.options.binary, ["--version"], null, 20_000);
    if (code !== 0) throw new Error(`${this.options.binary} --version exited ${code}: ${stderr.slice(0, 120)}`);
    return `${path} (${stdout.trim().split("\n")[0] ?? "no version reported"})`;
  }

  async complete(_model: string, request: CompletionRequest): Promise<CompletionResult> {
    const prompt = renderPrompt(request);
    const args = this.options.promptOnStdin
      ? this.options.args
      : this.options.args.map((arg) => arg.replace("{PROMPT}", prompt));

    const { stdout, stderr, code } = await run(
      this.options.binary,
      args,
      this.options.promptOnStdin ? prompt : null,
      this.options.timeoutMs ?? 10 * 60 * 1000,
      request.cwd,
    );

    if (code !== 0) {
      throw new ProviderError(
        `${this.options.binary} exited ${code}: ${truncate(stderr, 500)}`,
        this.id,
        false,
      );
    }

    return {
      text: stdout.trim(),
      // A CLI agent's own tool use is invisible to us; it never returns calls
      // for the hive to execute.
      toolCalls: [],
      stopReason: "end",
      // Spend happens under the CLI's own account and is not observable here.
      usage: { ...ZERO_USAGE },
    };
  }
}

function renderPrompt(request: CompletionRequest): string {
  const transcript = request.messages
    .map((turn) => {
      const text = turn.content
        .map((part) => {
          if (part.type === "text") return part.text;
          if (part.type === "tool_call") return `[called ${part.name}]`;
          return `[result] ${part.content}`;
        })
        .join("\n");
      return `### ${turn.role}\n${text}`;
    })
    .join("\n\n");
  return `${request.system}\n\n${transcript}`;
}

function run(
  binary: string,
  args: string[],
  stdin: string | null,
  timeoutMs: number,
  cwd?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const executable = which(binary) ?? binary;
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      ...(cwd ? { cwd } : {}),
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err), code: 127 });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });

    if (stdin !== null) child.stdin.end(stdin);
    else child.stdin.end();
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
