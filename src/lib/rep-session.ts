import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { reps, type Rep } from "@/db/schema";
import { sign, unsign } from "./crypto";

const COOKIE = "rep_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export async function startRepSession(repId: string) {
  const jar = await cookies();
  jar.set(COOKIE, sign(repId), {
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
  const token = (await cookies()).get(COOKIE)?.value;
  const repId = unsign(token);
  if (!repId) return null;

  const [rep] = await db.select().from(reps).where(eq(reps.id, repId)).limit(1);
  return rep ?? null;
}

/** Guard for every rep-only page and action. */
export async function requireRep(): Promise<Rep> {
  const rep = await getRep();
  if (!rep) redirect("/login");
  return rep;
}
