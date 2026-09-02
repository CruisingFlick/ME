import "server-only";
import { and, desc, eq, ne } from "drizzle-orm";
import { requestItems, requests, type RequestStatus } from "@/db/schema";
import type { Tx } from "@/db/scoped";

export const STATUS_LABELS: Record<RequestStatus, string> = {
  draft: "Draft",
  received: "Received",
  quoted: "Quoted",
  ordered: "Ordered",
  declined: "Declined",
};

/** What the customer is told each status means. */
export const STATUS_BLURB: Record<RequestStatus, string> = {
  draft: "Not sent yet — add what you need and send it through.",
  received: "Your rep has this and will get to it next business morning.",
  quoted: "Your rep has priced this up and will be in touch.",
  ordered: "This has been ordered.",
  declined: "Your rep couldn't proceed with this one — check their note.",
};

/** The forward path a rep moves a request along. */
export const NEXT_STATUS: Partial<Record<RequestStatus, RequestStatus>> = {
  received: "quoted",
  quoted: "ordered",
};

/*
 * Each of these takes the scoped transaction rather than importing a database
 * handle. Row-level security means an unscoped call would silently return
 * nothing, so making the caller pass its scope keeps that mistake impossible
 * to make by accident.
 */

/**
 * A customer has exactly one open draft at a time — that's their basket.
 * Created on demand so there's never an empty draft cluttering anything.
 */
export async function getOrCreateDraft(
  tx: Tx,
  repId: string,
  customerId: string,
) {
  const [existing] = await tx
    .select()
    .from(requests)
    .where(
      and(
        eq(requests.repId, repId),
        eq(requests.customerId, customerId),
        eq(requests.status, "draft"),
      ),
    )
    .orderBy(desc(requests.createdAt))
    .limit(1);

  if (existing) return existing;

  const [created] = await tx
    .insert(requests)
    .values({ repId, customerId, status: "draft" })
    .returning();
  return created;
}

export async function getRequestItems(tx: Tx, requestId: string) {
  return tx
    .select()
    .from(requestItems)
    .where(eq(requestItems.requestId, requestId))
    .orderBy(requestItems.createdAt);
}

/** A customer's submitted history — drafts are excluded, they aren't orders yet. */
export async function getCustomerHistory(tx: Tx, customerId: string) {
  const rows = await tx
    .select()
    .from(requests)
    .where(and(eq(requests.customerId, customerId), ne(requests.status, "draft")))
    .orderBy(desc(requests.submittedAt));

  return Promise.all(
    rows.map(async (r) => ({ ...r, items: await getRequestItems(tx, r.id) })),
  );
}

/**
 * Ownership check used by every rep-side mutation. The rep_id predicate is now
 * belt and braces — the policy would exclude another rep's row anyway — but it
 * keeps the intent readable at the call site.
 */
export async function getRepRequest(tx: Tx, repId: string, requestId: string) {
  const [row] = await tx
    .select()
    .from(requests)
    .where(and(eq(requests.id, requestId), eq(requests.repId, repId)))
    .limit(1);
  return row ?? null;
}
