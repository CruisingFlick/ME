import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { asRep } from "@/db/scoped";
import { customers, requestItems, requests } from "@/db/schema";
import { getRep } from "@/lib/rep-session";
import {
  triageRequests,
  TriageNotConfiguredError,
  type TriageInput,
} from "@/lib/triage";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A batch of requests through a reasoning model can take a while.
export const maxDuration = 60;

/** Cap one run so a backlog can't turn into a surprise bill. */
const MAX_PER_RUN = 40;

export async function POST() {
  const rep = await getRep();
  if (!rep) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  // Paid add-on, per rep. Checked here and not only in the UI — hiding the
  // button is presentation; this is the part that actually can't be bypassed.
  if (!rep.triageEnabled) {
    return NextResponse.json(
      {
        error:
          "Morning triage isn't switched on for this account. Talk to us and we'll turn it on.",
      },
      { status: 402 },
    );
  }

  // Each run costs money at the API, so cap how often one rep can fire it.
  const gate = await rateLimit("triage", rep.id);
  if (!gate.ok) {
    return NextResponse.json(
      {
        error: `Triage has run several times already this hour. Try again in ${Math.ceil(gate.retryAfter / 60)} minutes.`,
      },
      { status: 429, headers: { "retry-after": String(gate.retryAfter) } },
    );
  }

  // Scoped to this rep, and only what hasn't been triaged yet — re-running
  // costs nothing and doesn't re-summarise what's already done.
  const rows = await asRep(rep.id, (tx) =>
    tx
    .select({ request: requests, customerName: customers.name })
    .from(requests)
    .innerJoin(customers, eq(requests.customerId, customers.id))
    .where(
      and(
        eq(requests.repId, rep.id),
        eq(requests.status, "received"),
        isNull(requests.triagedAt),
      ),
    )
      .orderBy(requests.submittedAt)
      .limit(MAX_PER_RUN),
  );

  if (rows.length === 0) return NextResponse.json({ triaged: 0 });

  const inputs: TriageInput[] = await asRep(rep.id, (tx) =>
    Promise.all(
      rows.map(async ({ request, customerName }) => ({
        ...request,
        customer: { id: request.customerId, name: customerName },
        items: await tx
          .select()
          .from(requestItems)
          .where(eq(requestItems.requestId, request.id))
          .orderBy(requestItems.createdAt),
      })),
    ),
  );

  let verdicts;
  try {
    verdicts = await triageRequests(inputs);
  } catch (err) {
    if (err instanceof TriageNotConfiguredError) {
      return NextResponse.json(
        {
          error:
            "Triage isn't set up on this deployment — ANTHROPIC_API_KEY is missing. Your requests are all still here, just untriaged.",
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        error:
          "Triage didn't run just now. Nothing has changed — your inbox is exactly as it was.",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  const now = new Date();
  await asRep(rep.id, (tx) =>
    Promise.all(
      verdicts.map((v) =>
        tx
        .update(requests)
        .set({
          triageSummary: v.summary,
          triagePriority: v.priority,
          triagedAt: now,
        })
        // rep_id in the predicate as well as the id: the write is constrained
        // to this rep's rows at the database, not just by the earlier select.
        .where(and(eq(requests.id, v.requestId), eq(requests.repId, rep.id))),
      ),
    ),
  );

  return NextResponse.json({ triaged: verdicts.length, of: rows.length });
}
