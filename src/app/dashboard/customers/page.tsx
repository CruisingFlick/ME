import Link from "next/link";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { asRep } from "@/db/scoped";
import { customers, requests } from "@/db/schema";
import { requireRep } from "@/lib/rep-session";

export default async function CustomersPage() {
  const rep = await requireRep();

  const { rows, open } = await asRep(rep.id, async (tx) => {
  const rows = await tx
    .select({
      id: customers.id,
      name: customers.name,
      contact: customers.contact,
      createdAt: customers.createdAt,
      requestCount: sql<number>`(
        select count(*)::int from ${requests}
        where ${requests.customerId} = ${customers.id}
          and ${requests.status} <> 'draft'
      )`,
    })
    .from(customers)
    .where(eq(customers.repId, rep.id))
    .orderBy(desc(customers.createdAt));

    const [{ open }] = await tx
      .select({ open: sql<number>`count(*)::int` })
      .from(requests)
      .where(and(eq(requests.repId, rep.id), ne(requests.status, "draft")));

    return { rows, open };
  });

  return (
    <main className="shell">
      <div className="row-between" style={{ padding: "1.25rem 0 0.75rem" }}>
        <div>
          <h1>Customers</h1>
          <p className="muted" style={{ marginBottom: 0 }}>
            {rows.length} customer{rows.length === 1 ? "" : "s"} · {open} request
            {open === 1 ? "" : "s"} all up. This list is yours.
          </p>
        </div>
        {/* Portability guarantee — one click, the whole book of business. */}
        <a className="btn btn-secondary" href="/api/export">
          Export CSV
        </a>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          No customers yet. Share your{" "}
          <Link href="/dashboard/share">invite link</Link> and they&rsquo;ll
          appear here as they identify themselves.
        </div>
      ) : (
        rows.map((c) => (
          <Link
            key={c.id}
            href={`/dashboard/customers/${c.id}`}
            className="card"
            style={{ display: "block", textDecoration: "none", color: "inherit" }}
          >
            <div className="row-between">
              <div>
                <strong>{c.name}</strong>
                <div className="tiny">{c.contact}</div>
              </div>
              <span className="muted">
                {c.requestCount} request{c.requestCount === 1 ? "" : "s"} →
              </span>
            </div>
          </Link>
        ))
      )}
    </main>
  );
}
