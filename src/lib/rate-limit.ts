import "server-only";
import { sql } from "drizzle-orm";
import { headers } from "next/headers";
import { db } from "@/db";

/**
 * Fixed-window rate limiting, counted in Postgres.
 *
 * Serverless instances share no memory, so an in-process counter caps nothing
 * once traffic spreads across invocations. The window is coarse on purpose:
 * this exists to stop someone hammering the scraper or grinding passwords, not
 * to shape traffic precisely.
 *
 * It **fails open**. If the limiter itself errors, the request proceeds — a
 * broken counter should never take the app down. That is the right trade for
 * abuse protection and the wrong one for authorisation, which is why nothing
 * here is load-bearing for access control.
 */

export type Limit = { limit: number; windowSeconds: number };

export const LIMITS = {
  /** Server-side fetch of an arbitrary URL — the most abusable endpoint. */
  scrape: { limit: 30, windowSeconds: 300 },
  /** Blob uploads cost storage. */
  upload: { limit: 20, windowSeconds: 300 },
  /** Each run costs real money at the API. */
  triage: { limit: 6, windowSeconds: 3600 },
  /*
   * Login is limited on two axes. Per IP is deliberately generous: a whole
   * office behind one NAT shares an address, and locking all of them out
   * because one person fat-fingers a password is worse than the attack it
   * prevents. The tight limit is per account, which is what actually stops
   * someone grinding at a specific rep.
   */
  login: { limit: 40, windowSeconds: 900 },
  loginAccount: { limit: 8, windowSeconds: 900 },
  /*
   * Reset gets its own bucket rather than sharing login's. Someone asking for
   * a reset has usually just failed several logins — charging those failures
   * against the reset limit would lock out the very person who needs it.
   */
  reset: { limit: 5, windowSeconds: 900 },
  /** Stops one IP minting endless customer rows against an invite link. */
  identify: { limit: 15, windowSeconds: 3600 },
} as const satisfies Record<string, Limit>;

export type LimitName = keyof typeof LIMITS;

export type RateVerdict = {
  ok: boolean;
  /** Seconds until the current window rolls over. Useful for Retry-After. */
  retryAfter: number;
};

/**
 * Best-effort client IP. Behind Vercel this is the left-most x-forwarded-for
 * entry. It is a soft signal — shared NATs collapse together, and it can be
 * spoofed where no proxy rewrites it — so it only ever gates unauthenticated
 * actions, never authorisation.
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim().slice(0, 64);
  return h.get("x-real-ip")?.slice(0, 64) ?? "unknown";
}

/**
 * Counts one hit against `<name>:<identifier>` and says whether it is allowed.
 *
 * The insert/update is a single atomic statement, so two concurrent requests
 * can't both read a stale count and each decide they're under the limit.
 */
export async function rateLimit(
  name: LimitName,
  identifier: string,
): Promise<RateVerdict> {
  const { limit, windowSeconds } = LIMITS[name];
  const bucket = `${name}:${identifier}`.slice(0, 200);

  try {
    const rows = await db.execute<{ count: number; retry_after: number }>(sql`
      with w as (
        select to_timestamp(
          floor(extract(epoch from now()) / ${windowSeconds}) * ${windowSeconds}
        ) as start
      )
      insert into rate_limits (bucket, window_start, count)
      select ${bucket}, w.start, 1 from w
      on conflict (bucket, window_start)
        do update set count = rate_limits.count + 1
      returning
        count,
        ceil(extract(epoch from (window_start + make_interval(secs => ${windowSeconds})) - now()))::int
          as retry_after
    `);

    const row = rows.rows[0];
    if (!row) return { ok: true, retryAfter: 0 };

    return {
      ok: Number(row.count) <= limit,
      retryAfter: Math.max(1, Number(row.retry_after) || windowSeconds),
    };
  } catch {
    // Fail open — see the note at the top of the file.
    return { ok: true, retryAfter: 0 };
  }
}

/** Removes windows that have long since closed. Safe to call occasionally. */
export async function sweepRateLimits() {
  try {
    await db.execute(
      sql`delete from rate_limits where window_start < now() - interval '1 day'`,
    );
  } catch {
    // Housekeeping only.
  }
}
