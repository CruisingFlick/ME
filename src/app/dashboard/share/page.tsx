import { headers } from "next/headers";
import { requireRep } from "@/lib/rep-session";
import { CopyLink } from "./CopyLink";

export default async function SharePage() {
  const rep = await requireRep();

  // Build from the actual request host so the link is right on localhost,
  // preview deploys and production alike.
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const link = `${proto}://${host}/r/${rep.slug}`;

  return (
    <main className="shell shell-narrow">
      <div style={{ padding: "1.25rem 0 0.5rem" }}>
        <h1>Your invite link</h1>
        <p className="muted">
          Send this to a customer however you already talk to them — text,
          WhatsApp, email, or in your signature. They tap it, put in their name
          and number, and they&rsquo;re in. No account, no password.
        </p>
      </div>

      <div className="card">
        <CopyLink link={link} />
      </div>

      <div className="card">
        <h2>Show a QR code instead</h2>
        <p className="muted">
          Standing in front of someone? Open this and let them scan it. It
          needs no login, so you can show it without your customer list being
          on screen — bookmark it or save it to your home screen.
        </p>
        <a className="btn btn-secondary" href={`/r/${rep.slug}/qr`} target="_blank" rel="noreferrer">
          Open my QR code
        </a>
      </div>

      <div className="card">
        <h2>What to tell them</h2>
        <p className="muted" style={{ marginBottom: 0 }}>
          &ldquo;Save this link on your phone. Any time you need something —
          middle of the night, on site, whenever — paste the product link, snap
          a photo, or just type it in. I&rsquo;ll have a quote back to you in the
          morning.&rdquo;
        </p>
      </div>

      <div className="card">
        <h2>On Android</h2>
        <p className="muted" style={{ marginBottom: 0 }}>
          Once they add the app to their home screen, it also appears in the
          Android share sheet — so they can share a product page straight in
          from any browser or app. iPhones don&rsquo;t support this, so iPhone
          customers use paste or photo instead.
        </p>
      </div>
    </main>
  );
}
