"use server";

import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { customers, reps } from "@/db/schema";
import { startCustomerSession } from "@/lib/customer-session";

export type IdentifyState = { error?: string } | undefined;

/**
 * Guardrail #3: the lightest identification that still lets a rep tell two
 * customers apart. No password, no email round-trip. Coming back with the same
 * contact under the same rep re-attaches you to your existing history.
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
    return { error: "Please enter your name and either an email or a phone number." };
  }

  const [rep] = await db
    .select({ id: reps.id })
    .from(reps)
    .where(eq(reps.slug, slug))
    .limit(1);
  if (!rep) return { error: "That invite link is no longer valid." };

  const normalised = contact.toLowerCase().replace(/\s+/g, "");

  const [existing] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.repId, rep.id), eq(customers.contact, normalised)))
    .limit(1);

  let customerId: string;
  if (existing) {
    customerId = existing.id;
    // Let a returning customer correct the name they gave last time.
    if (existing.name !== name) {
      await db.update(customers).set({ name }).where(eq(customers.id, existing.id));
    }
  } else {
    const [created] = await db
      .insert(customers)
      .values({ repId: rep.id, name, contact: normalised })
      .returning({ id: customers.id });
    customerId = created.id;
  }

  await startCustomerSession(customerId);

  // `next` carries the share-target payload through identification so a shared
  // link isn't lost when a first-time customer has to identify first.
  redirect(next && next.startsWith("/shop") ? next : "/shop");
}
