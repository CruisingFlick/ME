"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { asRep } from "@/db/scoped";
import {
  customerNotes,
  customers,
  requests,
  REQUEST_STATUSES,
  type RequestStatus,
} from "@/db/schema";
import { requireRep } from "@/lib/rep-session";
import { getRepRequest } from "@/lib/requests";

export async function setRequestStatus(data: FormData) {
  const rep = await requireRep();
  const requestId = String(data.get("requestId") ?? "");
  const status = String(data.get("status") ?? "") as RequestStatus;

  if (!REQUEST_STATUSES.includes(status) || status === "draft") return;

  // Scoped by rep_id — a rep cannot touch another rep's request.
  await asRep(rep.id, async (tx) => {
    if (!(await getRepRequest(tx, rep.id, requestId))) return;
    await tx
      .update(requests)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(requests.id, requestId), eq(requests.repId, rep.id)));
  });

  revalidatePath("/dashboard");
  revalidatePath(`/dashboard/requests/${requestId}`);
}

/** The rep's reply back to the customer — this one IS customer-visible. */
export async function setRepMessage(data: FormData) {
  const rep = await requireRep();
  const requestId = String(data.get("requestId") ?? "");
  const message = String(data.get("repMessage") ?? "").trim() || null;

  await asRep(rep.id, async (tx) => {
    if (!(await getRepRequest(tx, rep.id, requestId))) return;
    await tx
      .update(requests)
      .set({ repMessage: message, updatedAt: new Date() })
      .where(and(eq(requests.id, requestId), eq(requests.repId, rep.id)));
  });

  revalidatePath(`/dashboard/requests/${requestId}`);
}

/**
 * Private note on a customer. Written here, read only under /dashboard.
 * There is deliberately no action or query anywhere on the customer side
 * that touches this table.
 */
export async function addCustomerNote(data: FormData) {
  const rep = await requireRep();
  const customerId = String(data.get("customerId") ?? "");
  const body = String(data.get("body") ?? "").trim();
  if (!body) return;

  await asRep(rep.id, async (tx) => {
    const [customer] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.repId, rep.id)))
      .limit(1);
    if (!customer) return;

    await tx.insert(customerNotes).values({
      repId: rep.id,
      customerId,
      body: body.slice(0, 2000),
    });
  });

  revalidatePath(`/dashboard/customers/${customerId}`);
}

export async function deleteCustomerNote(data: FormData) {
  const rep = await requireRep();
  const noteId = String(data.get("noteId") ?? "");
  const customerId = String(data.get("customerId") ?? "");

  await asRep(rep.id, (tx) =>
    tx
      .delete(customerNotes)
      .where(and(eq(customerNotes.id, noteId), eq(customerNotes.repId, rep.id))),
  );

  revalidatePath(`/dashboard/customers/${customerId}`);
}
