"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { reps } from "@/db/schema";
import { hashPassword, slugify, verifyPassword } from "@/lib/crypto";
import { endRepSession, startRepSession } from "@/lib/rep-session";
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

  const [existing] = await db
    .select({ id: reps.id })
    .from(reps)
    .where(eq(reps.email, email))
    .limit(1);
  if (existing) return { error: "An account with that email already exists." };

  // Slugs are the public part of the invite link, so they must be unique.
  const base = slugify(businessName || name);
  let slug = base;
  for (let n = 2; ; n++) {
    const [taken] = await db
      .select({ id: reps.id })
      .from(reps)
      .where(eq(reps.slug, slug))
      .limit(1);
    if (!taken) break;
    slug = `${base}-${n}`;
  }

  const [rep] = await db
    .insert(reps)
    .values({
      name,
      email,
      passwordHash: hashPassword(password),
      businessName: businessName || name,
      slug,
    })
    .returning();

  await startRepSession(rep.id);
  redirect("/dashboard");
}

export async function logInRep(
  _prev: FormState,
  data: FormData,
): Promise<FormState> {
  const email = str(data, "email").toLowerCase();
  const password = String(data.get("password") ?? "");

  const [rep] = await db
    .select()
    .from(reps)
    .where(eq(reps.email, email))
    .limit(1);

  // Same message either way — don't leak which emails have accounts.
  if (!rep || !verifyPassword(password, rep.passwordHash)) {
    return { error: "Email or password is incorrect." };
  }

  await startRepSession(rep.id);
  redirect("/dashboard");
}

export async function logOutRep() {
  await endRepSession();
  redirect("/");
}

export async function logOutCustomer() {
  await endCustomerSession();
  redirect("/");
}
