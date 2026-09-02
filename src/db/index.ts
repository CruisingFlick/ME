import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env.local and point it at your Neon database.",
  );
}

/**
 * A pooled TCP connection, not Neon's HTTP driver.
 *
 * This is forced by row-level security: every query runs inside a transaction
 * that first sets `app.rep_id` (or `app.customer_id`) with SET LOCAL, and the
 * policies read it back. The HTTP driver sends each statement as an independent
 * request with no session, so the setting would be gone by the time the query
 * ran — policies would see NULL and, being fail-closed, return nothing.
 *
 * Neon accepts ordinary Postgres connections; use the *pooled* connection
 * string (the one with `-pooler` in the host) so serverless invocations share
 * PgBouncer rather than opening a connection each.
 */
const globalForDb = globalThis as unknown as { __pool?: Pool };

const pool =
  globalForDb.__pool ??
  new Pool({
    connectionString: url,
    // Serverless: keep the per-instance footprint small and don't hold
    // connections open across cold starts.
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });

if (process.env.NODE_ENV !== "production") globalForDb.__pool = pool;

/**
 * The unscoped handle. Under RLS this sees *nothing* in the tenant tables —
 * every real query goes through one of the helpers in `./scoped`, which open a
 * transaction and set the tenant context first.
 */
export const db = drizzle(pool, { schema });

export { schema, pool };
