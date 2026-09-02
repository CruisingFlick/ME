import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { customerNotes, customers, requestItems } from "@/db/schema";
import { requireRep } from "@/lib/rep-session";
import { getRepRequest, NEXT_STATUS, STATUS_LABELS } from "@/lib/requests";
import { StatusBadge } from "@/components/StatusBadge";
import { ItemCard } from "@/components/ItemCard";
import { setRepMessage, setRequestStatus } from "@/app/actions/rep";
import { SubmitButton } from "@/components/SubmitButton";

export default async function RepRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const rep = await requireRep();
  const { id } = await params;

  // Scoped lookup — another rep's request id simply 404s.
  const request = await getRepRequest(rep.id, id);
  if (!request || request.status === "draft") notFound();

  const [customer] = await db
    .select()
    .from(customers)
    .where(eq(customers.id, request.customerId))
    .limit(1);

  const items = await db
    .select()
    .from(requestItems)
    .where(eq(requestItems.requestId, request.id))
    .orderBy(requestItems.createdAt);

  // Rep-only. Shown here to save a click while re-keying the order.
  const notes = await db
    .select()
    .from(customerNotes)
    .where(eq(customerNotes.customerId, customer.id))
    .orderBy(desc(customerNotes.createdAt))
    .limit(3);

  const next = NEXT_STATUS[request.status];

  return (
    <main className="shell">
      <p className="tiny" style={{ paddingTop: "1rem" }}>
        <Link href="/dashboard">← All requests</Link>
      </p>

      <div className="row-between" style={{ marginBottom: "1rem" }}>
        <div>
          <h1 style={{ marginBottom: "0.35rem" }}>{customer.name}</h1>
          <div className="muted">{customer.contact}</div>
        </div>
        <StatusBadge status={request.status} />
      </div>

      {request.triageSummary && (
        <div className="notice" style={{ marginBottom: "1rem" }}>
          <strong>Triage:</strong> {request.triageSummary}
        </div>
      )}

      <section className="card">
        <h2>Items ({items.length})</h2>
        <ul className="list-reset">
          {items.map((item) => (
            <ItemCard key={item.id} item={item} />
          ))}
        </ul>
        {request.customerMessage && (
          <div className="notice" style={{ marginTop: "0.75rem" }}>
            <strong>Customer note:</strong> {request.customerMessage}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Move it along</h2>
        <p className="muted">
          The customer sees this status on their own screen.
        </p>
        <div className="row">
          {next && (
            <form action={setRequestStatus}>
              <input type="hidden" name="requestId" value={request.id} />
              <input type="hidden" name="status" value={next} />
              <SubmitButton pendingLabel="Updating…">
                Mark as {STATUS_LABELS[next]}
              </SubmitButton>
            </form>
          )}
          {(["received", "quoted", "ordered", "declined"] as const)
            .filter((s) => s !== request.status && s !== next)
            .map((s) => (
              <form action={setRequestStatus} key={s}>
                <input type="hidden" name="requestId" value={request.id} />
                <input type="hidden" name="status" value={s} />
                <button type="submit" className="btn btn-secondary">
                  {STATUS_LABELS[s]}
                </button>
              </form>
            ))}
        </div>
      </section>

      <section className="card">
        <h2>Reply to the customer</h2>
        <form action={setRepMessage}>
          <input type="hidden" name="requestId" value={request.id} />
          <textarea
            name="repMessage"
            defaultValue={request.repMessage ?? ""}
            placeholder="e.g. Quoted $1,240 inc GST, quote #48213 emailed through. Two of the three are in stock."
          />
          <div style={{ marginTop: "0.6rem" }}>
            <SubmitButton className="btn btn-secondary" pendingLabel="Saving…">
              Save reply
            </SubmitButton>
          </div>
        </form>
      </section>

      <section className="card private">
        <h2>Your private notes</h2>
        <p className="tiny">
          Only you can see these. They are never shown to the customer.
        </p>
        {notes.length === 0 ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            No notes on {customer.name} yet.
          </p>
        ) : (
          <ul className="list-reset">
            {notes.map((n) => (
              <li key={n.id} className="tiny" style={{ padding: "0.25rem 0" }}>
                {n.body}
              </li>
            ))}
          </ul>
        )}
        <p style={{ marginTop: "0.6rem", marginBottom: 0 }}>
          <Link href={`/dashboard/customers/${customer.id}`}>
            Manage notes for {customer.name} →
          </Link>
        </p>
      </section>
    </main>
  );
}
