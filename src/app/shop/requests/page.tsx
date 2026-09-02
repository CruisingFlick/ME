import { requireCustomer } from "@/lib/customer-session";
import { asCustomer } from "@/db/scoped";
import { getCustomerHistory, STATUS_BLURB } from "@/lib/requests";
import { StatusBadge } from "@/components/StatusBadge";
import { ItemCard } from "@/components/ItemCard";
import { reorder } from "@/app/actions/basket";

function when(d: Date | null) {
  if (!d) return "";
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

export default async function MyRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string }>;
}) {
  const { customer } = await requireCustomer();
  const { sent } = await searchParams;
  const history = await asCustomer(customer.id, (tx) =>
    getCustomerHistory(tx, customer.id),
  );

  return (
    <main className="shell shell-narrow">
      <div style={{ padding: "1.25rem 0 0.5rem" }}>
        <h1>My requests</h1>
      </div>

      {sent && (
        <div className="notice notice-ok">
          Sent. Your rep will see it marked <strong>Received</strong> and get
          back to you.
        </div>
      )}

      {history.length === 0 ? (
        <div className="empty">
          You haven&rsquo;t sent any requests yet.
        </div>
      ) : (
        history.map((r) => (
          <section className="card" key={r.id}>
            <div className="row-between">
              <div>
                <StatusBadge status={r.status} />
                <div className="tiny" style={{ marginTop: "0.3rem" }}>
                  Sent {when(r.submittedAt)}
                </div>
              </div>
              <form action={reorder}>
                <input type="hidden" name="requestId" value={r.id} />
                <button type="submit" className="btn btn-secondary">
                  Reorder
                </button>
              </form>
            </div>

            <p className="muted" style={{ margin: "0.6rem 0 0" }}>
              {STATUS_BLURB[r.status]}
            </p>

            {/* The rep's reply — distinct from their private notes, which never
                reach this page. */}
            {r.repMessage && (
              <div className="notice" style={{ marginTop: "0.6rem" }}>
                <strong>From your rep:</strong> {r.repMessage}
              </div>
            )}

            {r.customerMessage && (
              <p className="tiny" style={{ marginTop: "0.4rem" }}>
                Your note: “{r.customerMessage}”
              </p>
            )}

            <ul className="list-reset" style={{ marginTop: "0.5rem" }}>
              {r.items.map((item) => (
                <ItemCard key={item.id} item={item} />
              ))}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}
