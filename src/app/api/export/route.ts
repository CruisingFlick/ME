import { and, asc, eq, ne } from "drizzle-orm";
import { asRep } from "@/db/scoped";
import { customerNotes, customers, requestItems, requests } from "@/db/schema";
import { getRep } from "@/lib/rep-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cell(value: unknown): string {
  if (value == null) return "";
  const s = value instanceof Date ? value.toISOString() : String(value);
  // Guard against a leading =, +, - or @ being run as a formula in Excel.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

/**
 * The portability guarantee (guardrail #2): one request, the rep's whole book
 * of business. Everything is filtered on rep_id, so a rep can only ever export
 * their own.
 */
export async function GET() {
  const rep = await getRep();
  if (!rep) return new Response("Not signed in.", { status: 401 });

  const { custRows, noteRows, reqRows, itemRows } = await asRep(
    rep.id,
    async (tx) => {
  const custRows = await tx
    .select()
    .from(customers)
    .where(eq(customers.repId, rep.id))
    .orderBy(asc(customers.createdAt));

  const noteRows = await tx
    .select()
    .from(customerNotes)
    .where(eq(customerNotes.repId, rep.id))
    .orderBy(asc(customerNotes.createdAt));

  const reqRows = await tx
    .select({
      request: requests,
      customerName: customers.name,
      customerContact: customers.contact,
    })
    .from(requests)
    .innerJoin(customers, eq(requests.customerId, customers.id))
    .where(and(eq(requests.repId, rep.id), ne(requests.status, "draft")))
    .orderBy(asc(requests.submittedAt));

  const itemRows = await tx
    .select({ item: requestItems, requestId: requests.id })
    .from(requestItems)
    .innerJoin(requests, eq(requestItems.requestId, requests.id))
    .where(and(eq(requests.repId, rep.id), ne(requests.status, "draft")))
    .orderBy(asc(requestItems.createdAt));

      return { custRows, noteRows, reqRows, itemRows };
    },
  );

  const sections = [
    "CUSTOMERS",
    toCsv(
      ["customer_id", "name", "contact", "created_at"],
      custRows.map((c) => [c.id, c.name, c.contact, c.createdAt]),
    ),
    "",
    "PRIVATE NOTES (rep only)",
    toCsv(
      ["note_id", "customer_id", "note", "created_at"],
      noteRows.map((n) => [n.id, n.customerId, n.body, n.createdAt]),
    ),
    "",
    "REQUESTS",
    toCsv(
      [
        "request_id",
        "customer_id",
        "customer_name",
        "customer_contact",
        "status",
        "customer_message",
        "rep_reply",
        "submitted_at",
        "updated_at",
      ],
      reqRows.map((r) => [
        r.request.id,
        r.request.customerId,
        r.customerName,
        r.customerContact,
        r.request.status,
        r.request.customerMessage,
        r.request.repMessage,
        r.request.submittedAt,
        r.request.updatedAt,
      ]),
    ),
    "",
    "REQUEST ITEMS",
    toCsv(
      [
        "item_id",
        "request_id",
        "title",
        "quantity",
        "price",
        "source_url",
        "image_url",
        "customer_note",
      ],
      itemRows.map(({ item }) => [
        item.id,
        item.requestId,
        item.title,
        item.quantity,
        item.price,
        item.sourceUrl,
        item.imageUrl,
        item.customerNote,
      ]),
    ),
  ];

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(sections.join("\r\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${rep.slug}-export-${stamp}.csv"`,
      "cache-control": "no-store",
    },
  });
}
