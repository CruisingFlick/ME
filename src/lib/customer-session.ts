import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { asCustomer } from "@/db/scoped";
import { customers, reps, type Customer, type Rep } from "@/db/schema";
import { signSession, verifySession } from "./crypto";

const COOKIE = "customer_session";
const MAX_AGE = 60 * 60 * 24 * 365; // a year — guardrail #3, customers should not re-identify

export type CustomerContext = {
  customer: Customer;
  /**
   * Only the fields a customer is allowed to see about their rep. Note what is
   * absent: no email, no password hash. Rep-only data — customer_notes above
   * all — has no read path on the customer side of the app at all.
   */
  rep: Pick<Rep, "id" | "name" | "businessName" | "slug">;
};

export async function startCustomerSession(customerId: string) {
  const jar = await cookies();
  jar.set(COOKIE, signSession(customerId, MAX_AGE), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function endCustomerSession() {
  (await cookies()).delete(COOKIE);
}

export async function getCustomerContext(): Promise<CustomerContext | null> {
  const session = verifySession((await cookies()).get(COOKIE)?.value);
  if (!session) return null;
  const customerId = session.sub;

  const [row] = await asCustomer(customerId, (tx) =>
    tx
    .select({
      customer: customers,
      repId: reps.id,
      repName: reps.name,
      repBusinessName: reps.businessName,
      repSlug: reps.slug,
    })
    .from(customers)
    .innerJoin(reps, eq(customers.repId, reps.id))
      .where(eq(customers.id, customerId))
      .limit(1),
  );

  if (!row) return null;

  return {
    customer: row.customer,
    rep: {
      id: row.repId,
      name: row.repName,
      businessName: row.repBusinessName,
      slug: row.repSlug,
    },
  };
}

export async function requireCustomer(): Promise<CustomerContext> {
  const ctx = await getCustomerContext();
  if (!ctx) redirect("/");
  return ctx;
}
