"use server";

import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { asAuth, asRep } from "@/db/scoped";
import { reps } from "@/db/schema";
import { hashPassword, slugify, verifyPassword } from "@/lib/crypto";
import { endRepSession, requireRep, startRepSession } from "@/lib/rep-session";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { endCustomerSession } from "@/lib/customer-session";

export type FormState = { error?: string } | undefined;

function str(data: FormData, key: string): string {
  return String(data.get(key) ?? "").trim();
}

export async function signUpRep(
  _prev: FormState,
  data: FormData,
): Promise<FormState> {
  const name = str(data, "name");
  const businessName = str(data, "businessName");
  const email = str(data, "email").toLowerCase();
  const password = String(data.get("password") ?? "");

  if (!name || !email || !password) {
    return { error: "Name, email and password are all required." };
  }
  if (!email.includes("@")) return { error: "That doesn't look like an email address." };
  if (password.length < 8) {
    return { error: "Use a password of at least 8 characters." };
  }

  const created = await asAuth(async (tx) => {
    const [existing] = await tx
      .select({ id: reps.id })
      .from(reps)
      .where(eq(reps.email, email))
      .limit(1);
    if (existing) return null;

    // Slugs are the public part of the invite link, so they must be unique.
    const base = slugify(businessName || name);
    let slug = base;
    for (let n = 2; ; n++) {
      const [taken] = await tx
        .select({ id: reps.id })
        .from(reps)
        .where(eq(reps.slug, slug))
        .limit(1);
      if (!taken) break;
      slug = `${base}-${n}`;
    }

    const [rep] = await tx
      .insert(reps)
      .values({
        name,
        email,
        passwordHash: hashPassword(password),
        businessName: businessName || name,
        slug,
      })
      .returning();
    return rep;
  });

  if (!created) return { error: "An account with that email already exists." };

  await startRepSession(created.id, created.sessionVersion);
  redirect("/dashboard");
}

export async function logInRep(
  _prev: FormState,
  data: FormData,
): Promise<FormState> {
  const email = str(data, "email").toLowerCase();
  const password = String(data.get("password") ?? "");

  // Per IP, before touching the database: this is the password-grinding gate.
  const gate = await rateLimit("login", await clientIp());
  if (!gate.ok) {
    return {
      error: `Too many attempts. Try again in ${Math.ceil(gate.retryAfter / 60)} minutes.`,
    };
  }

  const [rep] = await asAuth((tx) =>
    tx.select().from(reps).where(eq(reps.email, email)).limit(1),
  );

  // Same message either way — don't leak which emails have accounts.
  if (!rep || !verifyPassword(password, rep.passwordHash)) {
    return { error: "Email or password is incorrect." };
  }

  await startRepSession(rep.id, rep.sessionVersion);
  redirect("/dashboard");
}

export async function logOutRep() {
  await endRepSession();
  redirect("/");
}

/**
 * Invalidates every session for this rep, on every device, including any cookie
 * value someone else may have copied. Bumping the version is enough — cookies
 * carry the version they were issued under, and getRep() refuses a mismatch.
 */
export async function logOutEverywhere() {
  const rep = await requireRep();

  await asRep(rep.id, (tx) =>
    tx
      .update(reps)
      .set({ sessionVersion: sql`${reps.sessionVersion} + 1` })
      .where(eq(reps.id, rep.id)),
  );

  await endRepSession();
  redirect("/login");
}

export async function logOutCustomer() {
  await endCustomerSession();
  redirect("/");
}
