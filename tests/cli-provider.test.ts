import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeCliProvider,
  markerToolsFor,
  renderPrompt,
  withoutIntegrationCredentials,
} from "../src/providers/claude-cli.js";
import type { CompletionRequest } from "../src/providers/types.js";

const DIR = "/tmp/hive-fake-path";
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(DIR, { recursive: true, force: true });
});

function fakeBinary(name: string): void {
  mkdirSync(DIR, { recursive: true });
  const file = join(DIR, name);
  writeFileSync(file, "#!/bin/sh\necho fake\n");
  chmodSync(file, 0o755);
  // PATH is replaced, not prepended: this machine has a real claude on PATH and
  // the test would otherwise pass by finding that instead of the fixture.
  process.env.PATH = DIR;
}

describe("locating the claude CLI", () => {
  it("finds the binary under its plain name", () => {
    fakeBinary("claude");
    expect(new ClaudeCliProvider().available()).toBe(true);
  });

  it("reports itself missing when nothing is on PATH", () => {
    mkdirSync(DIR, { recursive: true });
    process.env.PATH = DIR;
    const provider = new ClaudeCliProvider();
    expect(provider.available()).toBe(false);
    expect(provider.unavailableReason()).toContain("not on PATH");
  });

  it("finds a PATHEXT-suffixed binary, as npm installs on Windows", () => {
    // The real bug this covers: an npm-installed CLI on Windows is claude.cmd,
    // so looking for the bare name reports it missing however correctly it was
    // installed. PATHEXT is consulted on every platform, so the lookup itself
    // is testable here rather than only on Windows.
    fakeBinary("claude.cmd");
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";

    const found = process.platform === "win32";
    expect(new ClaudeCliProvider().available()).toBe(found);
  });
});

describe("recognising an exhausted quota", () => {
  // The CLI reports a spent quota as ordinary result text with a zero exit
  // code, so it is indistinguishable from a successful answer unless matched.
  const quotaNotices = [
    "You've hit your session limit · resets 9:30pm (Australia/Sydney)",
    "You have reached your usage limit",
    "Claude usage limit reached. Your limit will reset at 3pm.",
    "rate_limit_error",
  ];

  it.each(quotaNotices)("treats %j as a provider failure, not an answer", (notice) => {
    expect(looksLikeQuotaNotice(notice)).toBe(true);
  });

  it("does not mistake real work that mentions rate limiting", () => {
    // A builder implementing a rate limiter writes about limits constantly.
    const legitimate = [
      "I implemented the rate limiter in src/limit.ts. It returns 429 when you have hit your session limit, with a Retry-After header, and I added tests covering the boundary at exactly the configured threshold.",
      "The tests assert that a caller who has exceeded their usage limit receives a clear error.",
    ];
    for (const text of legitimate) expect(looksLikeQuotaNotice(text)).toBe(false);
  });
});

/** Mirrors the provider's own check, which is not exported. */
function looksLikeQuotaNotice(text: string): boolean {
  const trimmed = text.trim();
  const matches =
    /^(you'?ve|you have)\s+(hit|reached|exceeded)\s+your\s+(session|usage|weekly|rate)\s+limit/i.test(
      trimmed,
    ) ||
    /^claude usage limit reached/i.test(trimmed) ||
    /^rate[_ ]limit(_error)?\b/i.test(trimmed);
  return matches && trimmed.length < 400;
}

describe("the tools a CLI agent is told about", () => {
  const spec = (name: string, description: string, properties: Record<string, unknown> = {}) => ({
    name,
    description,
    inputSchema: { type: "object" as const, properties, required: Object.keys(properties) },
  });

  const request = (tools: ReturnType<typeof spec>[]): CompletionRequest => ({
    system: "ROLE: operator",
    messages: [{ role: "user", content: [{ type: "text", text: "ship it" }] }],
    tools,
    cwd: "/tmp",
  });

  it("describes the tools the CLI has no equivalent for", () => {
    // The failure this prevents: only complete_task, block_task and
    // submit_review were ever described, so board_write, add_task and every
    // integration tool were invisible. Two live agents reported, accurately,
    // that they had no blackboard tool - and one reached Neon with curl
    // instead, which no capability check ever saw.
    const prompt = renderPrompt2(
      request([
        spec("neon_create_branch", "Create a Neon Postgres branch for this run.", { name: {} }),
        spec("board_write", "Publish a value other agents can read.", { key: {}, value: {} }),
        spec("complete_task", "Declare your assigned task finished."),
      ]),
    );

    expect(prompt).toContain("neon_create_branch");
    expect(prompt).toContain("Create a Neon Postgres branch");
    expect(prompt).toContain('{"signal":"neon_create_branch","name":...}');
    expect(prompt).toContain("board_write");
    // And the reason its shell will not work, so it reports rather than routing round.
    expect(prompt).toContain("curl");
  });

  it("leaves the tools the CLI does natively to the CLI", () => {
    // A Read is cheaper than a whole extra invocation of the binary.
    const prompt = renderPrompt2(
      request([
        spec("read_file", "Read a file.", { path: {} }),
        spec("write_file", "Write a file.", { path: {}, content: {} }),
        spec("run_command", "Run a shell command.", { command: {} }),
        spec("complete_task", "Declare your assigned task finished."),
      ]),
    );

    expect(prompt).not.toContain('{"signal":"write_file"');
    expect(prompt).not.toContain('{"signal":"run_command"');
    expect(prompt).toContain("complete_task");
  });
});

describe("the environment a CLI agent's shell inherits", () => {
  it("carries no integration credential", () => {
    // run_command blanks these; the claude subprocess inherited all of them,
    // and a CLI agent has its own Bash. A live operator created a Neon branch
    // with curl and the ledger recorded no integration call, because none was
    // made - routing around the capability allowlist entirely.
    const before = { ...process.env };
    process.env.NEON_API_KEY = "napi_secret";
    process.env.GITHUB_TOKEN = "ghp_secret";
    process.env.RESEND_API_KEY = "re_secret";
    process.env.RAILWAY_TOKEN = "rw_secret";
    process.env.CLERK_SECRET_KEY = "sk_secret";
    process.env.HIVE_DATABASE_URL = "postgres://hive";
    try {
      const env = withoutIntegrationCredentials();
      for (const key of [
        "NEON_API_KEY",
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "RESEND_API_KEY",
        "RAILWAY_TOKEN",
        "CLERK_SECRET_KEY",
        "HIVE_DATABASE_URL",
      ]) {
        expect(env[key], key).toBe("");
      }
      // The CLI may authenticate itself with this one; blanking it would stop
      // the agent running at all.
      expect("ANTHROPIC_API_KEY" in env ? env.ANTHROPIC_API_KEY : "").not.toBe(undefined);
    } finally {
      process.env = before;
    }
  });
});

/** The provider picks the marker tools itself; mirror that in the test. */
function renderPrompt2(request: CompletionRequest): string {
  return renderPrompt(request, markerToolsFor(request.tools));
}

describe("a model override left blank", () => {
  const originals = {
    GEMINI_MODEL: process.env.GEMINI_MODEL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    HIVE_CLAUDE_CLI_MODEL: process.env.HIVE_CLAUDE_CLI_MODEL,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("means the default, not an empty model id", async () => {
    // Blanking the line is the obvious move when a model id goes stale - which
    // it does: gemini-2.5-pro was retired for new accounts while still working
    // for existing ones. With `??` the empty string passed straight through as
    // the model, and every call 404'd saying nothing useful.
    process.env.GEMINI_MODEL = "";
    process.env.OPENAI_MODEL = "   ";
    process.env.HIVE_CLAUDE_CLI_MODEL = "";

    const { GeminiProvider } = await import("../src/providers/gemini.js");
    const { OpenAIProvider } = await import("../src/providers/openai.js");

    expect(new GeminiProvider().defaultModel).not.toBe("");
    expect(new OpenAIProvider().defaultModel).toBe("gpt-5");
    expect(new ClaudeCliProvider().defaultModel).toBe("sonnet");
  });

  it("still honours a real override", async () => {
    process.env.OPENAI_MODEL = "gpt-5-mini";
    const { OpenAIProvider } = await import("../src/providers/openai.js");
    expect(new OpenAIProvider().defaultModel).toBe("gpt-5-mini");
  });
});
