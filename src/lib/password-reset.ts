/*
 * No `server-only` guard here, unlike the other lib modules: this is also
 * imported by the `rep:reset` CLI, which runs outside Next. It can't reach a
 * client bundle regardless — it imports the database layer, and `pg` doesn't
 * bundle for the browser.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { passwordResets, reps } from "@/db/schema";
import { asAuth } from "@/db/scoped";
import { hashPassword } from "./crypto";

/** An hour is long enough to find the email, short enough to limit exposure. */
const TTL_SECONDS = 60 * 60;

/**
 * Reset tokens.
 *
 * The token goes to the rep; only its SHA-256 hash is stored. A stolen database
 * dump therefore contains nothing that can be used to reset an account — the
 * same reason passwords are hashed.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Issues a reset token for an email address.
 *
 * Returns null when no account matches — the caller must still show the same
 * message either way, so the page can't be used to discover which emails have
 * accounts.
 */
export async function createResetToken(
  email: string,
): Promise<{ token: string; repId: string; name: string } | null> {
  const token = generateToken();

  return asAuth(async (tx) => {
    const [rep] = await tx
      .select({ id: reps.id, name: reps.name })
      .from(reps)
      .where(eq(reps.email, email.toLowerCase().trim()))
      .limit(1);
    if (!rep) return null;

    // Any earlier outstanding token is retired — requesting a new link should
    // invalidate the old one rather than leave several live at once.
    await tx
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(
        and(eq(passwordResets.repId, rep.id), isNull(passwordResets.usedAt)),
      );

    await tx.insert(passwordResets).values({
      repId: rep.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + TTL_SECONDS * 1000),
    });

    return { token, repId: rep.id, name: rep.name };
  });
}

/** True when a token is live: exists, unused, unexpired. */
export async function isTokenValid(token: string): Promise<boolean> {
  if (!token) return false;

  return asAuth(async (tx) => {
    const [row] = await tx
      .select({ id: passwordResets.id })
      .from(passwordResets)
      .where(
        and(
          eq(passwordResets.tokenHash, hashToken(token)),
          isNull(passwordResets.usedAt),
          gt(passwordResets.expiresAt, new Date()),
        ),
      )
      .limit(1);
    return Boolean(row);
  });
}

export type ResetOutcome =
  | { ok: true; repId: string }
  | { ok: false; reason: "invalid" };

/**
 * Consumes a token and sets the new password.
 *
 * Everything happens in one transaction, and the token is marked used in the
 * same statement that checks it is unused — so two simultaneous submissions
 * can't both succeed.
 *
 * Resetting also bumps `session_version`, which signs out every existing
 * session for the account. That is the point of a reset when someone else may
 * have had access: the old cookies stop working.
 */
export async function consumeResetToken(
  token: string,
  newPassword: string,
): Promise<ResetOutcome> {
  if (!token) return { ok: false, reason: "invalid" };

  return asAuth(async (tx) => {
    const claimed = await tx
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResets.tokenHash, hashToken(token)),
          isNull(passwordResets.usedAt),
          gt(passwordResets.expiresAt, new Date()),
        ),
      )
      .returning({ repId: passwordResets.repId });

    const row = claimed[0];
    if (!row) return { ok: false, reason: "invalid" as const };

    await tx
      .update(reps)
      .set({
        passwordHash: hashPassword(newPassword),
        sessionVersion: sql`${reps.sessionVersion} + 1`,
      })
      .where(eq(reps.id, row.repId));

    return { ok: true as const, repId: row.repId };
  });
}

/** Constant-time compare, exported for tests of the hashing helper. */
export function tokenMatchesHash(token: string, hash: string): boolean {
  const a = Buffer.from(hashToken(token));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}
