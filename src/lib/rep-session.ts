import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { asAuth } from "@/db/scoped";
import { reps, type Rep } from "@/db/schema";
import { signSession, verifySession } from "./crypto";

const COOKIE = "rep_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export async function startRepSession(repId: string, sessionVersion: number) {
  const jar = await cookies();
  jar.set(COOKIE, signSession(repId, MAX_AGE, sessionVersion), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function endRepSession() {
  (await cookies()).delete(COOKIE);
}

/** Returns the signed-in rep, or null. Never throws on a bad cookie. */
export async function getRep(): Promise<Rep | null> {
  // Signature and expiry are checked here; the version needs the account row.
  const session = verifySession((await cookies()).get(COOKIE)?.value);
  if (!session) return null;

  // asAuth, not asRep: we are establishing who the rep is, so there is no
  // rep context to scope by yet. It grants nothing beyond the reps table.
  const [rep] = await asAuth((tx) =>
    tx.select().from(reps).where(eq(reps.id, session.sub)).limit(1),
  );
  if (!rep) return null;

  // A cookie issued before a password change or a "log out everywhere" lags
  // the account's current version and is refused.
  if (session.v !== rep.sessionVersion) return null;

  return rep;
}

/** Guard for every rep-only page and action. */
export async function requireRep(): Promise<Rep> {
  const rep = await getRep();
  if (!rep) redirect("/login");
  return rep;
}
