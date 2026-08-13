import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { drizzle as drizzleNode } from "drizzle-orm/node-postgres";
import { neon } from "@neondatabase/serverless";
import { Pool } from "pg";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local and point it at your Neon database.",
  );
}

/**
 * Neon's HTTP driver is the right fit on Vercel (no connection pooling to
 * manage across serverless invocations), but it only speaks to Neon. Any other
 * Postgres — a local instance for development or CI — goes over TCP.
 */
const isNeon = /neon\.(tech|build)/.test(url);

/**
 * Both drivers expose the same query builder. They are declared under a single
 * concrete type rather than a union, because a union of the two collapses the
 * generic call signatures on `.returning()` and friends at every call site.
 */
type Db = ReturnType<typeof drizzleNode<typeof schema>>;

// Cached on globalThis so Next.js hot reloads don't open a new pool each time.
const globalForDb = globalThis as unknown as { __db?: Db };

export const db: Db =
  globalForDb.__db ??
  (isNeon
    ? (drizzleNeon(neon(url), { schema }) as unknown as Db)
    : drizzleNode(new Pool({ connectionString: url }), { schema }));

if (process.env.NODE_ENV !== "production") globalForDb.__db = db;

export { schema };
