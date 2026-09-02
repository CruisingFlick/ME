import { NextResponse } from "next/server";
import { getCustomerContext } from "@/lib/customer-session";
import { scrapeProduct } from "@/lib/scrape";
import { rateLimit } from "@/lib/rate-limit";

// Node runtime: the scraper needs full fetch/streaming behaviour.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Only identified customers can drive the fetcher — it isn't an open proxy.
  const ctx = await getCustomerContext();
  if (!ctx) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  // Keyed on the customer, not the IP: an identified customer is the unit of
  // abuse here, and a shared site NAT shouldn't punish a whole crew.
  const gate = await rateLimit("scrape", ctx.customer.id);
  if (!gate.ok) {
    return NextResponse.json(
      {
        error:
          "That's a lot of links at once. Give it a minute, or type the item in.",
      },
      { status: 429, headers: { "retry-after": String(gate.retryAfter) } },
    );
  }

  let url = "";
  try {
    const body = (await req.json()) as { url?: unknown };
    url = typeof body.url === "string" ? body.url : "";
  } catch {
    // fall through to the empty-url branch
  }

  if (!url.trim()) {
    return NextResponse.json({ error: "No link supplied." }, { status: 400 });
  }

  // scrapeProduct never throws — a degraded result is still a 200.
  const result = await scrapeProduct(url);
  return NextResponse.json(result);
}
