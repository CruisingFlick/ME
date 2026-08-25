import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import type { Capability } from "./types.js";

/**
 * Keys whose value came from .env rather than the ambient environment.
 *
 * Recorded so `doctor` can show where each credential was read from. A stale
 * variable left in a shell silently shadowing the .env someone just edited is
 * a miserable thing to debug from a 401 alone.
 */
const fromDotenv = new Set<string>();

/**
 * .env wins over the ambient environment, which is the opposite of dotenv's
 * default. For a CLI whose configuration file *is* .env, a forgotten export
 * shadowing the file the user just edited is the more likely mistake by far -
 * and deployments inject real environment variables without shipping a .env,
 * so nothing is overridden there.
 */
const parsed = loadDotenv({ quiet: true, override: true });
for (const key of Object.keys(parsed.parsed ?? {})) fromDotenv.add(key);

/** Where a configuration value was read from, for diagnostics. */
export function sourceOf(key: string): ".env" | "environment" | "default" {
  if (fromDotenv.has(key)) return ".env";
  return process.env[key] !== undefined ? "environment" : "default";
}

/**
 * Everything the hive can be told about the outside world lives here.
 * Absent credentials are not an error: the corresponding integration simply
 * reports itself unavailable and the operator agent routes around it.
 */
const Schema = z.object({
  // --- model providers -----------------------------------------------------
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),

  // --- infrastructure integrations ----------------------------------------
  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPO: z.string().optional(), // owner/repo
  NEON_API_KEY: z.string().optional(),
  NEON_PROJECT_ID: z.string().optional(),
  RAILWAY_TOKEN: z.string().optional(),
  RAILWAY_PROJECT_ID: z.string().optional(),
  RAILWAY_ENVIRONMENT_ID: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().optional(),
  NOTIFY_EMAIL: z.string().optional(),

  // --- hive state ----------------------------------------------------------
  /** Postgres (Neon) connection string for durable run state. Falls back to memory. */
  HIVE_DATABASE_URL: z.string().optional(),
  HIVE_WORKSPACE: z.string().default(".hive/workspace"),
  HIVE_STATE_DIR: z.string().default(".hive"),

  // --- guardrails ----------------------------------------------------------
  HIVE_MAX_USD: z.coerce.number().positive().default(25),
  HIVE_MAX_AGENT_USD: z.coerce.number().positive().default(8),
  HIVE_MAX_TURNS: z.coerce.number().int().positive().default(40),
  HIVE_MAX_PARALLEL: z.coerce.number().int().positive().default(3),
  HIVE_MAX_REVIEW_ROUNDS: z.coerce.number().int().positive().default(3),
  HIVE_WALL_CLOCK_MINUTES: z.coerce.number().positive().default(90),
  /** Comma-separated capabilities the run may exercise. */
  HIVE_GRANTS: z.string().default(DEFAULT_GRANTS_CSV()),
  HIVE_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

function DEFAULT_GRANTS_CSV(): string {
  // Everything except the three that can destroy something that cannot be
  // rebuilt from the repo. Opt into those explicitly.
  return [
    "fs:read",
    "fs:write",
    "shell:exec",
    "net:read",
    "bus:send",
    "board:write",
    "task:manage",
    "github:read",
    "github:write",
    "db:read",
    "db:write",
    "deploy:preview",
  ].join(",");
}

export type RawConfig = z.infer<typeof Schema>;

export interface HiveConfig extends RawConfig {
  grants: Set<Capability>;
}

let cached: HiveConfig | null = null;

export function loadConfig(overrides: Partial<NodeJS.ProcessEnv> = {}): HiveConfig {
  const parsed = Schema.parse({ ...process.env, ...overrides });
  const grants = new Set(
    parsed.HIVE_GRANTS.split(",")
      .map((s) => s.trim())
      .filter(Boolean) as Capability[],
  );
  return { ...parsed, grants };
}

export function getConfig(): HiveConfig {
  cached ??= loadConfig();
  return cached;
}

/** Test seam: drop the memoised config so the next getConfig() re-reads env. */
export function resetConfig(): void {
  cached = null;
}
