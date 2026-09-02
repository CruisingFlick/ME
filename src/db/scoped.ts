import { sql } from "drizzle-orm";
import { db } from "./index";

/**
 * Tenant-scoped database access.
 *
 * Row-level security decides what a query can see from a per-transaction
 * setting, so every query has to run inside a transaction that sets it first.
 * These helpers are the only place that happens — which means the tenant
 * boundary is four functions to review rather than every query in the app.
 *
 * The important property: an unscoped query isn't a leak, it's an empty
 * result. `app.rep_id` unset makes the policies match no rows.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function scope<T>(
  settings: Record<string, string>,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    for (const [key, value] of Object.entries(settings)) {
      // `true` = local to this transaction, so the setting can never leak onto
      // the next request that borrows this pooled connection.
      await tx.execute(sql`select set_config(${key}, ${value}, true)`);
    }
    return fn(tx);
  });
}

/** Everything a signed-in rep does. Sees only that rep's rows. */
export function asRep<T>(repId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return scope({ "app.rep_id": repId }, fn);
}

/** Everything an identified customer does. Sees only their own rows — never notes. */
export function asCustomer<T>(
  customerId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return scope({ "app.customer_id": customerId }, fn);
}

/**
 * Signup, login, and the public invite page — the paths that must look up a rep
 * before any session exists. Grants visibility of `reps` and `customers` only;
 * requests, items, notes and favourites stay invisible.
 */
export function asAuth<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return scope({ "app.auth": "on" }, fn);
}

/**
 * Full access, for the CLI and the migration runner. Never call this from a
 * request path — there is no user whose identity it represents.
 */
export function asAdmin<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return scope({ "app.admin": "on" }, fn);
}

export type { Tx };
