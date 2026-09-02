"use server";

import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { asAuth } from "@/db/scoped";
import { customers, reps } from "@/db/schema";
import { startCustomerSession } from "@/lib/customer-session";
import { clientIp, rateLimit } from "@/lib/rate-limit";

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

  // Invite links are public, so this is the one place an anonymous visitor can
  // create rows. Capped per IP.
  const gate = await rateLimit("identify", await clientIp());
  if (!gate.ok) {
    return { error: "Too many attempts from here. Try again a bit later." };
  }

  const normalised = contact.toLowerCase().replace(/\s+/g, "");

  // asAuth: identifying happens before a customer session exists, so there is
  // no customer context to scope by yet.
  const customerId = await asAuth(async (tx) => {
    const [rep] = await tx
      .select({ id: reps.id })
      .from(reps)
      .where(eq(reps.slug, slug))
      .limit(1);
    if (!rep) return null;

    const [existing] = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.repId, rep.id), eq(customers.contact, normalised)))
      .limit(1);

    if (existing) {
      // Let a returning customer correct the name they gave last time.
      if (existing.name !== name) {
        await tx
          .update(customers)
          .set({ name })
          .where(eq(customers.id, existing.id));
      }
      return existing.id;
    }

    const [created] = await tx
      .insert(customers)
      .values({ repId: rep.id, name, contact: normalised })
      .returning({ id: customers.id });
    return created.id;
  });

  if (!customerId) return { error: "That invite link is no longer valid." };

  await startCustomerSession(customerId);

  // `next` carries the share-target payload through identification so a shared
  // link isn't lost when a first-time customer has to identify first.
  redirect(next && next.startsWith("/shop") ? next : "/shop");
}
