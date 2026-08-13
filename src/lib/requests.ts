import "server-only";
import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { requestItems, requests, type RequestStatus } from "@/db/schema";

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

/**
 * A customer has exactly one open draft at a time — that's their basket.
 * Created on demand so there's never an empty draft cluttering anything.
 */
export async function getOrCreateDraft(repId: string, customerId: string) {
  const [existing] = await db
    .select()
    .from(requests)
    .where(
      and(
        eq(requests.customerId, customerId),
        eq(requests.status, "draft"),
      ),
    )
    .orderBy(desc(requests.createdAt))
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(requests)
    .values({ repId, customerId, status: "draft" })
    .returning();
  return created;
}

export async function getDraftItems(requestId: string) {
  return db
    .select()
    .from(requestItems)
    .where(eq(requestItems.requestId, requestId))
    .orderBy(requestItems.createdAt);
}

/** A customer's submitted history — drafts are excluded, they aren't orders yet. */
export async function getCustomerHistory(customerId: string) {
  const rows = await db
    .select()
    .from(requests)
    .where(and(eq(requests.customerId, customerId), ne(requests.status, "draft")))
    .orderBy(desc(requests.submittedAt));

  return Promise.all(
    rows.map(async (r) => ({ ...r, items: await getDraftItems(r.id) })),
  );
}

/**
 * Ownership check used by every rep-side mutation: a rep can only ever touch a
 * request carrying their own rep_id (guardrail #2).
 */
export async function getRepRequest(repId: string, requestId: string) {
  const [row] = await db
    .select()
    .from(requests)
    .where(and(eq(requests.id, requestId), eq(requests.repId, repId)))
    .limit(1);
  return row ?? null;
}
