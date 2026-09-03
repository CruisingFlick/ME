"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { reps } from "@/db/schema";
import { asAuth, asRep } from "@/db/scoped";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { hashPassword, verifyPassword } from "@/lib/crypto";
import { revalidatePath } from "next/cache";
import { consumeResetToken, createResetToken } from "@/lib/password-reset";
import { emailConfigured, resetEmailBody, sendEmail } from "@/lib/email";
import { requireRep, startRepSession } from "@/lib/rep-session";

export type ForgotState =
  | { sent: true; manualLink?: string }
  | { error: string }
  | undefined;

async function baseUrl(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * Requests a reset link.
 *
 * Always reports the same thing whether or not the email matches an account —
 * otherwise this page becomes a way to find out who has one.
 */
export async function requestReset(
  _prev: ForgotState,
  data: FormData,
): Promise<ForgotState> {
  const email = String(data.get("email") ?? "").trim();
  if (!email) return { error: "Enter the email address on your account." };

  // Its own bucket — see the note on LIMITS.reset. Someone asking for a reset
  // has usually just failed a few logins, and must not be locked out for it.
  const gate = await rateLimit("reset", await clientIp());
  if (!gate.ok) {
    return {
      error: `Too many attempts. Try again in ${Math.ceil(gate.retryAfter / 60)} minutes.`,
    };
  }

  const issued = await createResetToken(email);

  // No account: stop here, but report success all the same.
  if (!issued) return { sent: true };

  const link = `${await baseUrl()}/reset/${issued.token}`;

  if (emailConfigured()) {
    await sendEmail({
      to: email,
      subject: "Reset your Rep Order App password",
      text: resetEmailBody(issued.name, link),
    });
    return { sent: true };
  }

  /*
   * No email provider configured. Rather than pretend a message was sent, the
   * link is shown so it can be passed on another way. Safe only because the
   * request is already rate limited and the token expires in an hour — and it
   * is shown for a real account only, so it still tells you nothing about an
   * address that has none.
   */
  return { sent: true, manualLink: link };
}

export type ResetState = { error: string } | undefined;

export async function completeReset(
  _prev: ResetState,
  data: FormData,
): Promise<ResetState> {
  const token = String(data.get("token") ?? "");
  const password = String(data.get("password") ?? "");
  const confirm = String(data.get("confirm") ?? "");

  if (password.length < 8) {
    return { error: "Use a password of at least 8 characters." };
  }
  if (password !== confirm) {
    return { error: "Those two passwords don't match." };
  }

  const outcome = await consumeResetToken(token, password);
  if (!outcome.ok) {
    return {
      error:
        "That link has expired or has already been used. Request a new one.",
    };
  }

  // Signing the rep straight in avoids an immediate second login. The reset
  // bumped session_version, so every other existing session is now dead.
  const [rep] = await asAuth((tx) =>
    tx
      .select({ id: reps.id, sessionVersion: reps.sessionVersion })
      .from(reps)
      .where(eq(reps.id, outcome.repId))
      .limit(1),
  );
  if (rep) await startRepSession(rep.id, rep.sessionVersion);

  redirect("/dashboard");
}

export type ChangeState = { error: string } | { changed: true } | undefined;

/**
 * Changes the password of the rep who is already signed in.
 *
 * Requires the current password: a session cookie alone should not be enough to
 * lock the real owner out of their own account, which is exactly what someone
 * with a borrowed laptop would try.
 *
 * Like a reset, this bumps `session_version` and so kills every other session —
 * but the cookie on *this* device is re-issued at the new version, so the
 * person doing it stays logged in rather than being bounced to the login page.
 */
export async function changePassword(
  _prev: ChangeState,
  data: FormData,
): Promise<ChangeState> {
  const rep = await requireRep();

  const current = String(data.get("current") ?? "");
  const password = String(data.get("password") ?? "");
  const confirm = String(data.get("confirm") ?? "");

  const gate = await rateLimit("passwordChange", rep.id);
  if (!gate.ok) {
    return {
      error: `Too many attempts. Try again in ${Math.ceil(gate.retryAfter / 60)} minutes.`,
    };
  }

  if (!verifyPassword(current, rep.passwordHash)) {
    return { error: "That isn't your current password." };
  }
  if (password.length < 8) {
    return { error: "Use a new password of at least 8 characters." };
  }
  if (password !== confirm) {
    return { error: "Those two passwords don't match." };
  }
  if (verifyPassword(password, rep.passwordHash)) {
    return { error: "That's the password you're already using." };
  }

  const [updated] = await asRep(rep.id, (tx) =>
    tx
      .update(reps)
      .set({
        passwordHash: hashPassword(password),
        sessionVersion: sql`${reps.sessionVersion} + 1`,
      })
      .where(eq(reps.id, rep.id))
      .returning({ sessionVersion: reps.sessionVersion }),
  );

  // Re-issue this device's cookie at the new version. Everything else is dead.
  if (updated) await startRepSession(rep.id, updated.sessionVersion);

  revalidatePath("/dashboard/account");
  return { changed: true };
}
