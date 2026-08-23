#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { getConfig } from "./config.js";
import { KillSwitch } from "./kernel/killswitch.js";
import { buildIntegrations, integrationStatus } from "./integrations/index.js";
import { Orchestrator, type RunReport } from "./orchestrator/orchestrator.js";
import { ProviderRegistry } from "./providers/registry.js";
import { ToolRegistry } from "./tools/registry.js";
import { setLogLevel } from "./util/log.js";

const USAGE = `hive - an autonomous multi-model engineering swarm

Usage:
  hive build --spec <file>       Plan, build, review, integrate and ship a project
  hive doctor                    Report which models and services are actually wired up
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
    case "doctor":
      return doctor();
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
  if (!flags.spec) {
    process.stderr.write("--spec is required\n\n" + USAGE);
    return 2;
  }
  const spec =
    flags.spec === "-"
      ? readFileSync(0, "utf8")
      : readFileSync(flags.spec, "utf8");

  if (!spec.trim()) {
    process.stderr.write("the specification is empty\n");
    return 2;
  }

  const orchestrator = await Orchestrator.create({
    spec,
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

function renderReport(report: RunReport): string {
  const lines: string[] = [
    "",
    `run       ${report.runId}`,
    `status    ${report.status}`,
    `workspace ${report.workspace}`,
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
  for (const [name, state] of Object.entries(integrationStatus(integrations))) {
    lines.push(`  ${state === "available" ? "ok" : "--"}  ${name.padEnd(12)} ${state}`);
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
