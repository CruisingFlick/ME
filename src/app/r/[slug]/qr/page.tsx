import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { reps } from "@/db/schema";
import { asAuth } from "@/db/scoped";
import { inviteQrSvg, initialsFor } from "@/lib/qr";

/**
 * The rep's QR code, on a page that needs no login.
 *
 * The point of it being public: a rep holding this up to a customer must not
 * have to open their dashboard, which would put every other customer's name and
 * order history on screen in front of them.
 *
 * Nothing here is private. It shows the business name and the invite link —
 * both of which are meant to be handed out, and the invite link on its own
 * grants nothing without identifying first.
 */
export default async function RepQrPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const [rep] = await asAuth((tx) =>
    tx
      .select({ businessName: reps.businessName, slug: reps.slug })
      .from(reps)
      .where(eq(reps.slug, slug))
      .limit(1),
  );
  if (!rep) notFound();

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3100";
  const proto =
    h.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const inviteUrl = `${proto}://${host}/r/${rep.slug}`;

  const svg = await inviteQrSvg(inviteUrl);

  return (
    <main className="qr-page">
      <div className="qr-card">
        <p className="qr-kicker">Scan to order from</p>
        <h1 className="qr-name">{rep.businessName}</h1>

        <div className="qr-holder">
          {/* The library returns a complete <svg>; it contains no user input. */}
          <div
            className="qr-svg"
            dangerouslySetInnerHTML={{ __html: svg }}
            aria-hidden="true"
          />
          <div className="qr-badge" aria-hidden="true">
            {initialsFor(rep.businessName)}
          </div>
        </div>

        <p className="qr-help">
          Point your camera at this. No app to install, no account to make.
        </p>

        <p className="qr-url">{inviteUrl}</p>
      </div>

      <p className="qr-footnote">
        Bookmark this page — you can show it without logging in.
      </p>
    </main>
  );
}
