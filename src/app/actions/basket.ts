"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { favourites, requestItems, requests } from "@/db/schema";
import { asCustomer, type Tx } from "@/db/scoped";
import { requireCustomer } from "@/lib/customer-session";
import { getOrCreateDraft } from "@/lib/requests";

function clampQty(raw: FormDataEntryValue | null): number {
  const n = Number.parseInt(String(raw ?? "1"), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, 999);
}

function cleanUrl(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The single entry point for all three capture methods. Paste, photo and share
 * differ only in which fields arrive already filled — by the time an item is
 * added it is the same row either way.
 */
export async function addItem(data: FormData) {
  const { customer, rep } = await requireCustomer();

  const title = String(data.get("title") ?? "").trim();
  const sourceUrl = cleanUrl(String(data.get("sourceUrl") ?? ""));
  const imageUrl = cleanUrl(String(data.get("imageUrl") ?? ""));
  const price = String(data.get("price") ?? "").trim() || null;
  const note = String(data.get("customerNote") ?? "").trim() || null;

  // Guardrail #4 in practice: an item with nothing but a link or a photo is
  // still a valid item — the rep can open one and look at the other. Give it a
  // placeholder name rather than silently dropping it.
  const finalTitle =
    title || (sourceUrl ? "Item from link" : imageUrl ? "Item from photo" : "");
  if (!finalTitle) return;

  await asCustomer(customer.id, async (tx) => {
    const draft = await getOrCreateDraft(tx, rep.id, customer.id);

    await tx.insert(requestItems).values({
      requestId: draft.id,
      title: finalTitle.slice(0, 500),
      sourceUrl,
      imageUrl,
      price: price ? price.slice(0, 120) : null,
      quantity: clampQty(data.get("quantity")),
      customerNote: note,
    });

    await tx
      .update(requests)
      .set({ updatedAt: new Date() })
      .where(eq(requests.id, draft.id));
  });

  revalidatePath("/shop");
}

/** Only a draft is editable — once it's sent, it's the rep's to work from. */
async function ownedDraftItem(tx: Tx, itemId: string, customerId: string) {
  const [row] = await tx
    .select({ id: requestItems.id, status: requests.status })
    .from(requestItems)
    .innerJoin(requests, eq(requestItems.requestId, requests.id))
    .where(and(eq(requestItems.id, itemId), eq(requests.customerId, customerId)))
    .limit(1);
  return row && row.status === "draft" ? row : null;
}

export async function updateItemQuantity(data: FormData) {
  const { customer } = await requireCustomer();
  const id = String(data.get("itemId") ?? "");
  const quantity = clampQty(data.get("quantity"));

  await asCustomer(customer.id, async (tx) => {
    if (!(await ownedDraftItem(tx, id, customer.id))) return;
    await tx
      .update(requestItems)
      .set({ quantity })
      .where(eq(requestItems.id, id));
  });

  revalidatePath("/shop");
}

export async function removeItem(data: FormData) {
  const { customer } = await requireCustomer();
  const id = String(data.get("itemId") ?? "");

  await asCustomer(customer.id, async (tx) => {
    if (!(await ownedDraftItem(tx, id, customer.id))) return;
    await tx.delete(requestItems).where(eq(requestItems.id, id));
  });

  revalidatePath("/shop");
}

export async function submitRequest(data: FormData) {
  const { customer, rep } = await requireCustomer();
  const message = String(data.get("customerMessage") ?? "").trim() || null;

  const draftId = await asCustomer(customer.id, async (tx) => {
    const draft = await getOrCreateDraft(tx, rep.id, customer.id);

    const items = await tx
      .select({ id: requestItems.id })
      .from(requestItems)
      .where(eq(requestItems.requestId, draft.id));
    if (items.length === 0) return null;

    const now = new Date();
    await tx
      .update(requests)
      .set({
        status: "received",
        customerMessage: message,
        submittedAt: now,
        updatedAt: now,
      })
      .where(and(eq(requests.id, draft.id), eq(requests.status, "draft")));

    return draft.id;
  });

  if (!draftId) return;

  revalidatePath("/shop");
  revalidatePath("/shop/requests");
  redirect(`/shop/requests?sent=${draftId}`);
}

/** Block 5: reorder — clone a past request's items into the current draft. */
export async function reorder(data: FormData) {
  const { customer, rep } = await requireCustomer();
  const sourceId = String(data.get("requestId") ?? "");

  const cloned = await asCustomer(customer.id, async (tx) => {
    const [source] = await tx
      .select({ id: requests.id })
      .from(requests)
      .where(and(eq(requests.id, sourceId), eq(requests.customerId, customer.id)))
      .limit(1);
    if (!source) return false;

    const items = await tx
      .select()
      .from(requestItems)
      .where(eq(requestItems.requestId, source.id));
    if (items.length === 0) return false;

    const draft = await getOrCreateDraft(tx, rep.id, customer.id);
    await tx.insert(requestItems).values(
      items.map((i) => ({
        requestId: draft.id,
        title: i.title,
        sourceUrl: i.sourceUrl,
        imageUrl: i.imageUrl,
        price: i.price,
        quantity: i.quantity,
        customerNote: i.customerNote,
      })),
    );
    return true;
  });

  if (!cloned) return;

  revalidatePath("/shop");
  redirect("/shop?reordered=1");
}

/** Block 5: favourites. */
export async function saveFavourite(data: FormData) {
  const { customer, rep } = await requireCustomer();
  const title = String(data.get("title") ?? "").trim();
  if (!title) return;

  await asCustomer(customer.id, (tx) =>
    tx.insert(favourites).values({
      repId: rep.id,
      customerId: customer.id,
      title: title.slice(0, 500),
      sourceUrl: cleanUrl(String(data.get("sourceUrl") ?? "")),
      imageUrl: cleanUrl(String(data.get("imageUrl") ?? "")),
      price: String(data.get("price") ?? "").trim() || null,
    }),
  );

  revalidatePath("/shop/favourites");
  revalidatePath("/shop");
}

export async function removeFavourite(data: FormData) {
  const { customer } = await requireCustomer();
  const id = String(data.get("favouriteId") ?? "");

  await asCustomer(customer.id, (tx) =>
    tx
      .delete(favourites)
      .where(and(eq(favourites.id, id), eq(favourites.customerId, customer.id))),
  );

  revalidatePath("/shop/favourites");
}

export async function addFavouritesToDraft(data: FormData) {
  const { customer, rep } = await requireCustomer();
  const ids = data.getAll("favouriteId").map(String).filter(Boolean);
  if (ids.length === 0) return;

  const added = await asCustomer(customer.id, async (tx) => {
    const rows = await tx
      .select()
      .from(favourites)
      .where(
        and(eq(favourites.customerId, customer.id), inArray(favourites.id, ids)),
      );
    if (rows.length === 0) return 0;

    const draft = await getOrCreateDraft(tx, rep.id, customer.id);
    await tx.insert(requestItems).values(
      rows.map((f) => ({
        requestId: draft.id,
        title: f.title,
        sourceUrl: f.sourceUrl,
        imageUrl: f.imageUrl,
        price: f.price,
        quantity: 1,
      })),
    );
    return rows.length;
  });

  if (added === 0) return;

  revalidatePath("/shop");
  redirect(`/shop?added=${added}`);
}
