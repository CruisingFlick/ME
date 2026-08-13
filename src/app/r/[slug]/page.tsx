import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { reps } from "@/db/schema";
import { getCustomerContext } from "@/lib/customer-session";
import { IdentifyForm } from "./IdentifyForm";

export default async function RepInvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ next?: string }>;
}) {
  const { slug } = await params;
  const { next } = await searchParams;

  const [rep] = await db
    .select({
      id: reps.id,
      name: reps.name,
      businessName: reps.businessName,
      slug: reps.slug,
    })
    .from(reps)
    .where(eq(reps.slug, slug))
    .limit(1);

  if (!rep) notFound();

  // Already identified with this same rep? Skip straight through.
  const existing = await getCustomerContext();
  if (existing && existing.rep.id === rep.id) {
    redirect(next && next.startsWith("/shop") ? next : "/shop");
  }

  return (
    <main className="shell shell-narrow">
      <div style={{ padding: "2rem 0 1rem" }}>
        <h1>{rep.businessName}</h1>
        <p className="muted">
          Send {rep.name} a product request any time — they&rsquo;ll pick it up
          next business morning and come back to you with a quote.
        </p>
      </div>

      <IdentifyForm slug={rep.slug} next={next} />

      <p className="tiny" style={{ textAlign: "center" }}>
        No password, no account. We just need to know who the request is from.
      </p>
    </main>
  );
}
