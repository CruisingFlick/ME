#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { getConfig, sourceOf } from "./config.js";
import { KillSwitch } from "./kernel/killswitch.js";
import { buildIntegrations, integrationStatus } from "./integrations/index.js";
import { Orchestrator, type RunReport } from "./orchestrator/orchestrator.js";
import { ProviderRegistry } from "./providers/registry.js";
import { ToolRegistry } from "./tools/registry.js";
import { setLogLevel } from "./util/log.js";
import { check, type VerifyResult } from "./verify.js";

const USAGE = `hive - an autonomous multi-model engineering swarm

Usage:
  hive build --spec <file>       Plan, build, review, integrate and ship a project
  hive plan --spec <file>        Produce and validate a plan only, and stop
  hive doctor                    Report which models and services are configured
  hive verify                    Prove every credential works, with real read-only calls
  hive halt [reason]             Stop every run immediately
  hive resume                    Clear a halt
  hive report <run-id>           Replay a run's ledger

Options for build:
  --spec <file>                  Specification file, or - for stdin        (required)
  --provider <id>                Model that builds        (default: anthropic)
  --model <id>                   Override that provider's default model
  --review-provider <id>         Model that reviews       (default: a different vendor)
  --review-model <id>            Override the reviewer's model
  --workspace <dir>              Where the project is built (default: .hive/workspace)
  --parallel <n>                 Builders running at once (default: HIVE_MAX_PARALLEL)
  --dry-run                      Build and review, but contact no external service
  --resume <run-id>              Continue an interrupted run instead of starting one
  --verbose                      Debug logging

Guardrails come from the environment: HIVE_MAX_USD, HIVE_MAX_AGENT_USD,
HIVE_WALL_CLOCK_MINUTES, HIVE_GRANTS. See .env.example.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  if (flags.verbose) setLogLevel("debug");
  else setLogLevel(getConfig().HIVE_LOG_LEVEL);

  switch (command) {
    case "build":
      return build(flags);
    case "plan":
      return planOnly(flags);
    case "doctor":
      return doctor();
    case "verify":
      return verify();
    case "halt":
      return halt(rest.join(" "));
    case "resume":
      return resume();
    case "report":
      return report(rest[0]);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

interface Flags {
  spec?: string;
  provider?: string;
  model?: string;
  "review-provider"?: string;
  "review-model"?: string;
  workspace?: string;
  parallel?: string;
  "dry-run"?: boolean;
  resume?: string;
  verbose?: boolean;
}

function parseFlags(args: string[]): Flags {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags as Flags;
}

async function build(flags: Flags): Promise<number> {
  const resuming = typeof flags.resume === "string" && flags.resume.length > 0;
  if (!flags.spec && !resuming) {
    process.stderr.write("--spec is required (or --resume <run-id>)\n\n" + USAGE);
    return 2;
  }

  // A resumed run reads its plan from stored state, so the spec is optional.
  const spec = !flags.spec
    ? ""
    : flags.spec === "-"
      ? readFileSync(0, "utf8")
      : readFileSync(flags.spec, "utf8");

  if (!spec.trim() && !resuming) {
    process.stderr.write("the specification is empty\n");
    return 2;
  }

  const orchestrator = await Orchestrator.create({
    spec,
    ...(resuming ? { runId: flags.resume, resume: true } : {}),
    provider: flags.provider,
    model: flags.model,
    reviewProvider: flags["review-provider"],
    reviewModel: flags["review-model"],
    workspace: flags.workspace,
    parallelism: flags.parallel ? Number(flags.parallel) : undefined,
    dryRun: Boolean(flags["dry-run"]),
  });

  try {
    const result = await orchestrator.run();
    process.stdout.write(renderReport(result));
    return result.status === "succeeded" ? 0 : 1;
  } finally {
    await orchestrator.close();
  }
}

async function planOnly(flags: Flags): Promise<number> {
  if (!flags.spec) {
    process.stderr.write("--spec is required\n");
    return 2;
  }
  const spec = flags.spec === "-" ? readFileSync(0, "utf8") : readFileSync(flags.spec, "utf8");
  const orchestrator = await Orchestrator.create({
    spec,
    provider: flags.provider,
    model: flags.model,
    workspace: flags.workspace,
  });
  try {
    const plan = await orchestrator.planOnly();
    const lines = [
      "",
      plan.summary,
      "",
      `stack        ${JSON.stringify(plan.stack)}`,
      `integrations ${plan.integrations.join(", ") || "(none)"}`,
      "",
      "tasks",
      ...plan.tasks.map((task) => {
        const after = task.dependsOn.length > 0 ? ` after ${task.dependsOn.join(",")}` : "";
        return `  ${task.id.padEnd(6)} ${task.title}${after}\n         owns: ${task.paths.join(", ") || "(unspecified)"}`;
      }),
      "",
      `spend        ${orchestrator.spendSummary}`,
      "",
    ];
    process.stdout.write(lines.join("\n"));
    return 0;
  } finally {
    await orchestrator.close();
  }
}

function renderReport(report: RunReport): string {
  const lines: string[] = [
    "",
    `run       ${report.runId}`,
    `status    ${report.status}`,
    `workspace ${report.workspace}`,
    `head      ${report.head?.slice(0, 12) ?? "(nothing merged)"} - ${report.filesTracked} file(s) tracked`,
    `spend     ${report.spendSummary}`,
    `ledger    ${report.ledgerPath}`,
    "",
    "phases",
    ...report.phases.map((p) => `  ${p.ok ? "ok  " : "FAIL"} ${p.phase.padEnd(10)} ${p.detail}`),
    "",
    "tasks",
    ...report.tasks.map(
      (t) => `  ${t.status.padEnd(18)} ${t.id.padEnd(10)} ${t.title}`,
    ),
  ];
  if (report.published) {
    lines.push(
      "",
      "published",
      `  branch  ${report.published.branch}`,
      `  commit  ${report.published.commit.slice(0, 12)}`,
      `  pr      ${report.published.pullRequest ?? "(none)"}`,
    );
  }
  if (report.notes.length > 0) {
    lines.push("", "notes", ...report.notes.map((n) => `  - ${n}`));
  }
  lines.push("");
  return lines.join("\n");
}

async function doctor(): Promise<number> {
  const config = getConfig();
  const providers = new ProviderRegistry();
  const integrations = buildIntegrations();
  const tools = new ToolRegistry();

  const lines: string[] = ["", "models"];
  for (const provider of providers.all()) {
    const reason = provider.unavailableReason();
    lines.push(
      `  ${reason ? "--" : "ok"}  ${provider.id.padEnd(12)} ${
        reason ?? `default model: ${provider.defaultModel}`
      }`,
    );
  }

  lines.push("", "services");
  const CREDENTIAL: Record<string, string> = {
    github: "GITHUB_TOKEN",
    neon: "NEON_API_KEY",
    railway: "RAILWAY_TOKEN",
    clerk: "CLERK_SECRET_KEY",
    resend: "RESEND_API_KEY",
  };
  for (const [name, state] of Object.entries(integrationStatus(integrations))) {
    // Where the credential came from, so a stale shell variable shadowing the
    // .env someone just edited is visible here rather than only as a 401.
    const key = CREDENTIAL[name];
    const from = key && state === "available" ? `  [from ${sourceOf(key)}]` : "";
    lines.push(`  ${state === "available" ? "ok" : "--"}  ${name.padEnd(12)} ${state}${from}`);
  }

  lines.push("", "guardrails");
  lines.push(`  spend cap        $${config.HIVE_MAX_USD} per run, $${config.HIVE_MAX_AGENT_USD} per agent`);
  lines.push(`  wall clock       ${config.HIVE_WALL_CLOCK_MINUTES} minutes`);
  lines.push(`  parallel builders ${config.HIVE_MAX_PARALLEL}`);
  lines.push(`  review rounds    ${config.HIVE_MAX_REVIEW_ROUNDS}`);
  lines.push(`  state            ${config.HIVE_DATABASE_URL ? "postgres" : "in-memory (set HIVE_DATABASE_URL for durable runs)"}`);

  const denied = (["db:destructive", "deploy:production", "email:send", "auth:admin"] as const).filter(
    (capability) => !config.grants.has(capability),
  );
  lines.push(`  granted          ${[...config.grants].join(", ")}`);
  if (denied.length > 0) lines.push(`  withheld         ${denied.join(", ")}`);

  const kill = new KillSwitch(config.HIVE_STATE_DIR);
  lines.push("", `halt state       ${kill.reason() ?? "clear"} (${kill.path})`);
  lines.push("", `tools registered ${tools.names().length}`, "");

  process.stdout.write(lines.join("\n"));
  return providers.availableIds().length > 0 ? 0 : 1;
}

/**
 * Make a real call against everything that claims to be configured.
 *
 * `doctor` reports what the environment says; this reports what the services
 * say back. The difference between the two is where an unattended run fails at
 * its most expensive moment.
 */
async function verify(): Promise<number> {
  const providers = new ProviderRegistry();
  const integrations = buildIntegrations();

  process.stdout.write("\nprobing every configured credential with a read-only call...\n\n");

  const checks: Array<Promise<VerifyResult>> = [
    ...providers.all().map((provider) =>
      check(provider.id, "model", provider.available(), provider.unavailableReason(), () =>
        provider.verify(),
      ),
    ),
    ...Object.values(integrations).map((service) =>
      check(service.name, "service", service.available(), service.unavailableReason(), () =>
        service.verify(),
      ),
    ),
  ];

  const results = await Promise.all(checks);
  const width = Math.max(...results.map((r) => r.name.length));

  for (const kind of ["model", "service"] as const) {
    process.stdout.write(`${kind}s\n`);
    for (const result of results.filter((r) => r.kind === kind)) {
      const mark = result.status === "ok" ? "ok  " : result.status === "failed" ? "FAIL" : "--  ";
      const timing = result.ms > 0 ? ` (${result.ms}ms)` : "";
      process.stdout.write(`  ${mark} ${result.name.padEnd(width)}  ${result.detail}${timing}\n`);
    }
    process.stdout.write("\n");
  }

  const failed = results.filter((r) => r.status === "failed");
  const workingModels = results.filter((r) => r.kind === "model" && r.status === "ok");

  if (failed.length > 0) {
    process.stdout.write(
      `${failed.length} credential(s) are set but do not work: ${failed.map((r) => r.name).join(", ")}\n` +
        `Fix these before an unattended run - it would discover them mid-build.\n\n`,
    );
    return 1;
  }
  if (workingModels.length === 0) {
    process.stdout.write("no working model provider - a run cannot start. Set ANTHROPIC_API_KEY.\n\n");
    return 1;
  }
  process.stdout.write(`everything configured is working (${workingModels.length} model provider(s)).\n\n`);
  return 0;
}

async function halt(reason: string): Promise<number> {
  const kill = new KillSwitch(getConfig().HIVE_STATE_DIR);
  kill.trip(reason.trim() || "halted from the command line");
  process.stdout.write(`halted: every running agent stops at its next checkpoint (${kill.path})\n`);
  return 0;
}

async function resume(): Promise<number> {
  const kill = new KillSwitch(getConfig().HIVE_STATE_DIR);
  kill.reset();
  process.stdout.write("halt cleared\n");
  return 0;
}

async function report(runId: string | undefined): Promise<number> {
  if (!runId) {
    process.stderr.write("usage: hive report <run-id>\n");
    return 2;
  }
  const path = `${getConfig().HIVE_STATE_DIR}/runs/${runId}.jsonl`;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    process.stderr.write(`no ledger at ${path}\n`);
    return 1;
  }
  for (const line of raw.split("\n").filter(Boolean)) {
    const event = JSON.parse(line) as { at: string; type: string; actor: string; data: unknown };
    process.stdout.write(
      `${event.at.slice(11, 19)}  ${event.type.padEnd(18)} ${event.actor.padEnd(14)} ${JSON.stringify(event.data).slice(0, 160)}\n`,
    );
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${String(err?.stack ?? err)}\n`);
    process.exit(1);
  });
