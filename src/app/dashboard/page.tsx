import Link from "next/link";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { asRep } from "@/db/scoped";
import { customers, requestItems, requests, type RequestStatus } from "@/db/schema";
import { requireRep } from "@/lib/rep-session";
import { STATUS_LABELS } from "@/lib/requests";
import { StatusBadge } from "@/components/StatusBadge";
import { PriorityBadge, PRIORITY_RANK } from "@/components/PriorityBadge";
import { TriageButton } from "./TriageButton";

const FILTERS: { key: string; label: string; statuses: RequestStatus[] }[] = [
  { key: "open", label: "Open", statuses: ["received", "quoted"] },
  { key: "received", label: "Received", statuses: ["received"] },
  { key: "quoted", label: "Quoted", statuses: ["quoted"] },
  { key: "ordered", label: "Ordered", statuses: ["ordered"] },
  { key: "all", label: "All", statuses: ["received", "quoted", "ordered", "declined"] },
];

function when(d: Date | null) {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const rep = await requireRep();
  const { filter } = await searchParams;
  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];

  // Drafts are the customer's private basket and never surface here.
  const rows = await asRep(rep.id, (tx) =>
    tx
    .select({
      id: requests.id,
      status: requests.status,
      submittedAt: requests.submittedAt,
      customerMessage: requests.customerMessage,
      triageSummary: requests.triageSummary,
      triagePriority: requests.triagePriority,
      triagedAt: requests.triagedAt,
      customerName: customers.name,
      customerId: customers.id,
      itemCount: sql<number>`(
        select count(*)::int from ${requestItems}
        where ${requestItems.requestId} = ${requests.id}
      )`,
    })
    .from(requests)
    .innerJoin(customers, eq(requests.customerId, customers.id))
      .where(and(eq(requests.repId, rep.id), ne(requests.status, "draft")))
      .orderBy(desc(requests.submittedAt)),
  );

  // Triage sorts the inbox; without it the list stays newest-first as before.
  const visible = rows
    .filter((r) => active.statuses.includes(r.status))
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.triagePriority ?? "untriaged"] -
        PRIORITY_RANK[b.triagePriority ?? "untriaged"],
    );

  const newCount = rows.filter((r) => r.status === "received").length;
  const untriaged = rows.filter(
    (r) => r.status === "received" && !r.triagedAt,
  ).length;

  return (
    <main className="shell">
      <div className="row-between" style={{ padding: "1.25rem 0 0.5rem" }}>
        <div>
          <h1>Requests</h1>
          <p className="muted" style={{ marginBottom: 0 }}>
            {newCount === 0
              ? "Nothing new waiting on you."
              : `${newCount} new request${newCount === 1 ? "" : "s"} to work through.`}
          </p>
        </div>
        {rep.triageEnabled && <TriageButton pending={untriaged} />}
      </div>

      <div className="row" style={{ marginBottom: "1rem" }}>
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`/dashboard?filter=${f.key}`}
            className={f.key === active.key ? "btn" : "btn btn-secondary"}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="empty">
          {rows.length === 0 ? (
            <>
              No requests yet. Share your{" "}
              <Link href="/dashboard/share">invite link</Link> with a customer to
              get started.
            </>
          ) : (
            <>Nothing under {active.label.toLowerCase()}.</>
          )}
        </div>
      ) : (
        visible.map((r) => (
          <Link
            key={r.id}
            href={`/dashboard/requests/${r.id}`}
            className="card"
            style={{ display: "block", textDecoration: "none", color: "inherit" }}
          >
            <div className="row-between">
              <div className="grow">
                <div className="row" style={{ gap: "0.5rem" }}>
                  <StatusBadge status={r.status} />
                  {r.triagePriority && (
                    <PriorityBadge priority={r.triagePriority} />
                  )}
                  <strong>{r.customerName}</strong>
                </div>
                <div className="tiny" style={{ marginTop: "0.25rem" }}>
                  {r.itemCount} item{r.itemCount === 1 ? "" : "s"} · sent{" "}
                  {when(r.submittedAt)}
                </div>
                {r.triageSummary && (
                  <p className="triage-summary">{r.triageSummary}</p>
                )}
                {r.customerMessage && (
                  <p className="muted" style={{ margin: "0.35rem 0 0" }}>
                    “{r.customerMessage}”
                  </p>
                )}
              </div>
              <span className="muted">Open →</span>
            </div>
          </Link>
        ))
      )}

      <p className="tiny" style={{ marginTop: "1.5rem" }}>
        Statuses: {Object.values(STATUS_LABELS).filter((s) => s !== "Draft").join(" · ")}
      </p>
    </main>
  );
}
