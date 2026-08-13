import Link from "next/link";
import { redirect } from "next/navigation";
import { getCustomerContext } from "@/lib/customer-session";

/**
 * Landing point for the Android share sheet (see share_target in the manifest).
 *
 * Chrome hands us title/text/url as query params. Which one carries the link
 * varies by the sharing app — some put the URL in `text`, some in `url`, some
 * bundle "Some Product Name https://…" into `text` — so we pass the likeliest
 * candidate through and let the scraper pull the URL out of it.
 */
export default async function SharePage({
  searchParams,
}: {
  searchParams: Promise<{ title?: string; text?: string; url?: string }>;
}) {
  const { title, text, url } = await searchParams;

  const shared = (url || text || "").trim();
  const ctx = await getCustomerContext();

  // Installing the app requires having opened a rep's invite link, so this is
  // an edge case (cleared cookies, a shared device). Don't silently swallow the
  // link — show it so it can be pasted once they're identified.
  if (!ctx) {
    return (
      <main className="shell shell-narrow">
        <div style={{ padding: "2rem 0 1rem" }}>
          <h1>Almost there</h1>
          <p className="muted">
            We don&rsquo;t know who you are on this device yet. Open the invite
            link your rep sent you, then share again — or just paste this in:
          </p>
        </div>
        <div className="card">
          <input readOnly value={shared} aria-label="The link you shared" />
        </div>
        <p className="muted" style={{ textAlign: "center" }}>
          <Link href="/">Back to the start</Link>
        </p>
      </main>
    );
  }

  const params = new URLSearchParams();
  if (shared) params.set("shareUrl", shared);
  if (title) params.set("shareTitle", title);
  const query = params.toString();

  redirect(`/shop${query ? `?${query}` : ""}`);
}
