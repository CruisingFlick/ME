import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { customerNotes, customers, requests } from "@/db/schema";
import { requireRep } from "@/lib/rep-session";
import { StatusBadge } from "@/components/StatusBadge";
import { addCustomerNote, deleteCustomerNote } from "@/app/actions/rep";
import { SubmitButton } from "@/components/SubmitButton";

function when(d: Date | null) {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-AU", { dateStyle: "medium" }).format(d);
}

export default async function CustomerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const rep = await requireRep();
  const { id } = await params;

  const [customer] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, id), eq(customers.repId, rep.id)))
    .limit(1);
  if (!customer) notFound();

  const history = await db
    .select()
    .from(requests)
    .where(and(eq(requests.customerId, customer.id), ne(requests.status, "draft")))
    .orderBy(desc(requests.submittedAt));

  const notes = await db
    .select()
    .from(customerNotes)
    .where(eq(customerNotes.customerId, customer.id))
    .orderBy(desc(customerNotes.createdAt));

  return (
    <main className="shell">
      <p className="tiny" style={{ paddingTop: "1rem" }}>
        <Link href="/dashboard/customers">← All customers</Link>
      </p>

      <div style={{ marginBottom: "1rem" }}>
        <h1 style={{ marginBottom: "0.25rem" }}>{customer.name}</h1>
        <div className="muted">
          {customer.contact} · with you since {when(customer.createdAt)}
        </div>
      </div>

      {/*
        Rep-only. This is the one screen in the app where customer_notes is
        read, and it sits behind requireRep() under /dashboard.
      */}
      <section className="card private">
        <h2>Private notes</h2>
        <p className="tiny">
          Just for you — {customer.name} can never see these.
        </p>

        <form action={addCustomerNote}>
          <input type="hidden" name="customerId" value={customer.id} />
          <textarea
            name="body"
            placeholder="e.g. Prefers Makita. Pays on time. Always wants the 5Ah kit, never the bare tool."
            required
          />
          <div style={{ marginTop: "0.6rem" }}>
            <SubmitButton className="btn btn-secondary" pendingLabel="Saving…">
              Add note
            </SubmitButton>
          </div>
        </form>

        {notes.length > 0 && (
          <ul className="list-reset" style={{ marginTop: "1rem" }}>
            {notes.map((n) => (
              <li key={n.id} className="row-between" style={{ padding: "0.4rem 0" }}>
                <div className="grow">
                  <div>{n.body}</div>
                  <div className="tiny">{when(n.createdAt)}</div>
                </div>
                <form action={deleteCustomerNote}>
                  <input type="hidden" name="noteId" value={n.id} />
                  <input type="hidden" name="customerId" value={customer.id} />
                  <button type="submit" className="btn-danger">
                    Delete
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Request history</h2>
        {history.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            No requests from {customer.name} yet.
          </p>
        ) : (
          <ul className="list-reset">
            {history.map((r) => (
              <li key={r.id} className="row-between" style={{ padding: "0.5rem 0" }}>
                <div className="row" style={{ gap: "0.5rem" }}>
                  <StatusBadge status={r.status} />
                  <span className="tiny">{when(r.submittedAt)}</span>
                </div>
                <Link href={`/dashboard/requests/${r.id}`}>Open →</Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
