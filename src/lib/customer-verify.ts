import "server-only";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { customerVerifications } from "@/db/schema";
import { asAuth } from "@/db/scoped";

/**
 * One-time codes for customers.
 *
 * The threat this closes: an invite link is public and a tradie's email is on
 * the side of their van, so "name + contact" alone is not proof of identity.
 * Without this, anyone holding both could open a customer's order history,
 * their pricing, and place orders in their name.
 *
 * It is deliberately only asked for on a device we don't recognise. A returning
 * customer on their own phone keeps the year-long cookie and sees nothing —
 * guardrail #3 survives, because the friction lands only where the risk is.
 */

const TTL_SECONDS = 10 * 60;
/** A 6-digit code is only safe with a hard guessing budget. */
const MAX_ATTEMPTS = 5;

function hashCode(customerId: string, code: string): string {
  // Salted with the customer id so an identical code for two customers doesn't
  // share a hash.
  return createHash("sha256").update(`${customerId}:${code}`).digest("hex");
}

/** Six digits, uniformly random, zero-padded. */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Issues a fresh code, retiring any earlier one for this customer. */
export async function createVerificationCode(
  customerId: string,
): Promise<string> {
  const code = generateCode();

  await asAuth(async (tx) => {
    await tx
      .update(customerVerifications)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(customerVerifications.customerId, customerId),
          isNull(customerVerifications.usedAt),
        ),
      );

    await tx.insert(customerVerifications).values({
      customerId,
      codeHash: hashCode(customerId, code),
      expiresAt: new Date(Date.now() + TTL_SECONDS * 1000),
    });
  });

  return code;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "wrong" | "expired" | "too-many" };

/**
 * Checks a submitted code.
 *
 * A wrong guess burns one of the attempts; running out invalidates the code
 * entirely rather than merely rejecting that try, so an attacker can't sit and
 * grind the same code.
 */
export async function checkVerificationCode(
  customerId: string,
  submitted: string,
): Promise<VerifyResult> {
  const code = submitted.replace(/\D/g, "");

  return asAuth(async (tx) => {
    const [row] = await tx
      .select()
      .from(customerVerifications)
      .where(
        and(
          eq(customerVerifications.customerId, customerId),
          isNull(customerVerifications.usedAt),
          gt(customerVerifications.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (!row) return { ok: false as const, reason: "expired" as const };

    if (row.attempts >= MAX_ATTEMPTS) {
      await tx
        .update(customerVerifications)
        .set({ usedAt: new Date() })
        .where(eq(customerVerifications.id, row.id));
      return { ok: false as const, reason: "too-many" as const };
    }

    const expected = Buffer.from(row.codeHash);
    const given = Buffer.from(hashCode(customerId, code));
    const match =
      expected.length === given.length && timingSafeEqual(expected, given);

    if (!match) {
      await tx
        .update(customerVerifications)
        .set({ attempts: sql`${customerVerifications.attempts} + 1` })
        .where(eq(customerVerifications.id, row.id));
      return { ok: false as const, reason: "wrong" as const };
    }

    await tx
      .update(customerVerifications)
      .set({ usedAt: new Date() })
      .where(eq(customerVerifications.id, row.id));

    return { ok: true as const };
  });
}

/** Is this contact something we can actually send a code to? */
export function isEmailAddress(contact: string): boolean {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(contact.trim());
}

/** Shows enough of an address to recognise, not enough to learn. */
export function maskContact(contact: string): string {
  const [user, domain] = contact.split("@");
  if (!domain) return contact;
  const head = user.slice(0, 2);
  return `${head}${"•".repeat(Math.max(1, user.length - 2))}@${domain}`;
}

export function codeEmailBody(code: string, businessName: string): string {
  return [
    `Your code for ${businessName} is:`,
    "",
    `    ${code}`,
    "",
    "It expires in 10 minutes and works once.",
    "",
    "If you didn't ask for this, someone may have entered your email address",
    "on your rep's order page. Nothing has been shared with them — you can",
    "safely ignore this.",
  ].join("\n");
}
