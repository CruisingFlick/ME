import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { customers } from "@/db/schema";
import { asAuth } from "@/db/scoped";
import { verifySession } from "@/lib/crypto";
import { startCustomerSession } from "@/lib/customer-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A rep-issued sign-in link.
 *
 * Covers what an emailed code can't: a customer whose contact is a mobile
 * number, and deployments with no email provider. The rep vouches for the
 * customer out-of-band — they know their own customers — and passes the link on
 * however they already talk to them.
 *
 * A route handler rather than a page, because starting a session means setting
 * a cookie, and Next.js only allows that from a route handler or a server
 * action — never during a page render.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const session = verifySession(token);

  if (session) {
    const [customer] = await asAuth((tx) =>
      tx
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.id, session.sub))
        .limit(1),
    );

    if (customer) {
      await startCustomerSession(customer.id);
      return NextResponse.redirect(new URL("/shop", _req.url));
    }
  }

  return NextResponse.redirect(new URL("/link-expired", _req.url));
}
