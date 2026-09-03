"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { reps } from "@/db/schema";
import { asAuth } from "@/db/scoped";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { consumeResetToken, createResetToken } from "@/lib/password-reset";
import { emailConfigured, resetEmailBody, sendEmail } from "@/lib/email";
import { startRepSession } from "@/lib/rep-session";

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
