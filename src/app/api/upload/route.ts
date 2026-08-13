import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { getCustomerContext } from "@/lib/customer-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — a phone photo, not a video
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

export async function POST(req: Request) {
  const ctx = await getCustomerContext();
  if (!ctx) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      {
        error:
          "Photo uploads aren't set up on this deployment yet. Type the item in instead — your rep will still get it.",
      },
      { status: 503 },
    );
  }

  const form = await req.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No photo received." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "That photo is over 8 MB — try a smaller one." },
      { status: 413 },
    );
  }
  if (file.type && !ALLOWED.includes(file.type.toLowerCase())) {
    return NextResponse.json(
      { error: "Photos only, please (JPG, PNG, WEBP or HEIC)." },
      { status: 415 },
    );
  }

  try {
    // Foldered per rep and customer so a rep's blobs are as scoped as their rows.
    const ext = (file.name.split(".").pop() ?? "jpg").toLowerCase().slice(0, 5);
    const blob = await put(
      `requests/${ctx.rep.id}/${ctx.customer.id}/${Date.now()}.${ext}`,
      file,
      { access: "public", addRandomSuffix: true, contentType: file.type || undefined },
    );

    return NextResponse.json({ url: blob.url });
  } catch {
    // Same principle as the scraper: an upload failure must not dead-end the flow.
    return NextResponse.json(
      {
        error:
          "Upload didn't go through. Type the item in instead and your rep will follow up.",
      },
      { status: 502 },
    );
  }
}
