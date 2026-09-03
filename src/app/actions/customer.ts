"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { asAuth } from "@/db/scoped";
import { customers, reps } from "@/db/schema";
import {
  getCustomerContext,
  startCustomerSession,
} from "@/lib/customer-session";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { signSession, verifySession } from "@/lib/crypto";
import { emailConfigured, sendEmail } from "@/lib/email";
import {
  checkVerificationCode,
  codeEmailBody,
  createVerificationCode,
  isEmailAddress,
  maskContact,
} from "@/lib/customer-verify";

/**
 * A short-lived cookie holding "who is trying to sign in", set between asking
 * for a code and receiving it. It is not a session: it grants nothing on its
 * own, and the code still has to check out.
 */
const PENDING = "customer_pending";
const PENDING_TTL = 15 * 60;

export type IdentifyState =
  | { needsCode: true; sentTo: string }
  | { needsRepLink: true; repName: string }
  | { error: string }
  | undefined;

/**
 * Step one of identifying.
 *
 * Three outcomes:
 *  - brand new customer → straight in. There is no history to protect yet, and
 *    first contact is the moment friction costs the most.
 *  - returning on the same device → straight in, via the year-long cookie.
 *  - returning on a new device → a code goes to their email first. An invite
 *    link is public and an email address is not a secret, so without this step
 *    knowing both would be enough to read someone's order history, see their
 *    pricing, and order in their name.
 */
export async function identifyCustomer(
  _prev: IdentifyState,
  data: FormData,
): Promise<IdentifyState> {
  const slug = String(data.get("slug") ?? "").trim();
  const name = String(data.get("name") ?? "").trim();
  const contact = String(data.get("contact") ?? "").trim();
  const next = String(data.get("next") ?? "").trim();

  if (!name || !contact) {
    return {
      error: "Please enter your name and either an email or a phone number.",
    };
  }

  const gate = await rateLimit("identify", await clientIp());
  if (!gate.ok) {
    return { error: "Too many attempts from here. Try again a bit later." };
  }

  const normalised = contact.toLowerCase().replace(/\s+/g, "");

  const found = await asAuth(async (tx) => {
    const [rep] = await tx
      .select({ id: reps.id, name: reps.name, businessName: reps.businessName })
      .from(reps)
      .where(eq(reps.slug, slug))
      .limit(1);
    if (!rep) return null;

    const [existing] = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.repId, rep.id), eq(customers.contact, normalised)))
      .limit(1);

    return { rep, existing: existing ?? null };
  });

  if (!found) return { error: "That invite link is no longer valid." };
  const { rep, existing } = found;

  // --- brand new customer: nothing to protect yet, let them in -------------
  if (!existing) {
    const created = await asAuth((tx) =>
      tx
        .insert(customers)
        .values({ repId: rep.id, name, contact: normalised })
        .returning({ id: customers.id }),
    );
    await startCustomerSession(created[0].id);
    redirect(next && next.startsWith("/shop") ? next : "/shop");
  }

  // --- already signed in as this very customer on this device --------------
  const current = await getCustomerContext();
  if (current && current.customer.id === existing.id) {
    redirect(next && next.startsWith("/shop") ? next : "/shop");
  }

  // --- returning on a device we don't know: prove it -----------------------
  if (!isEmailAddress(normalised) || !emailConfigured()) {
    // A mobile can't receive an email, and some deployments have no email
    // provider at all. Rather than wave them through, the rep issues a
    // one-time sign-in link from their dashboard.
    return { needsRepLink: true, repName: rep.name };
  }

  const code = await createVerificationCode(existing.id);
  await sendEmail({
    to: normalised,
    subject: `Your code for ${rep.businessName}`,
    text: codeEmailBody(code, rep.businessName),
  });

  // Remember who is mid-sign-in, without granting anything.
  const jar = await cookies();
  jar.set(PENDING, signSession(`${existing.id}|${name}|${next}`, PENDING_TTL), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: PENDING_TTL,
  });

  return { needsCode: true, sentTo: maskContact(normalised) };
}

export type CodeState = { error: string } | undefined;

/** Step two: check the code and, only then, start a real session. */
export async function submitCode(
  _prev: CodeState,
  data: FormData,
): Promise<CodeState> {
  const jar = await cookies();
  const pending = verifySession(jar.get(PENDING)?.value);
  if (!pending) {
    return {
      error: "That took too long. Start again and we'll send a new code.",
    };
  }

  const [customerId, name, next] = pending.sub.split("|");

  const gate = await rateLimit("verifyCode", customerId);
  if (!gate.ok) {
    return { error: "Too many tries. Wait a few minutes and start again." };
  }

  const result = await checkVerificationCode(
    customerId,
    String(data.get("code") ?? ""),
  );

  if (!result.ok) {
    if (result.reason === "wrong") return { error: "That code isn't right." };
    if (result.reason === "too-many") {
      return { error: "Too many wrong tries. Start again for a fresh code." };
    }
    return { error: "That code has expired. Start again for a fresh one." };
  }

  // Let a returning customer correct the name they gave last time.
  if (name) {
    await asAuth((tx) =>
      tx.update(customers).set({ name }).where(eq(customers.id, customerId)),
    );
  }

  jar.delete(PENDING);
  await startCustomerSession(customerId);
  redirect(next && next.startsWith("/shop") ? next : "/shop");
}

/** Abandon a half-finished sign-in and go back to the start. */
export async function cancelPendingCode(data: FormData) {
  const slug = String(data.get("slug") ?? "");
  (await cookies()).delete(PENDING);
  redirect(`/r/${slug}`);
}
