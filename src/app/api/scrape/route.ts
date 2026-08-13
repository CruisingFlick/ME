import { NextResponse } from "next/server";
import { getCustomerContext } from "@/lib/customer-session";
import { scrapeProduct } from "@/lib/scrape";

// Node runtime: the scraper needs full fetch/streaming behaviour.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Only identified customers can drive the fetcher — it isn't an open proxy.
  const ctx = await getCustomerContext();
  if (!ctx) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
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
