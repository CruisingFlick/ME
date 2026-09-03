import Link from "next/link";
import { isTokenValid } from "@/lib/password-reset";
import { ResetForm } from "./ResetForm";

export default async function ResetPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Checked before rendering the form so a dead link says so immediately
  // rather than after the rep has typed a new password twice.
  const valid = await isTokenValid(token);

  if (!valid) {
    return (
      <main className="shell shell-narrow">
        <div style={{ padding: "2rem 0 1rem" }}>
          <h1>That link has expired</h1>
          <p className="muted">
            Reset links work once and last an hour. Ask for a fresh one and
            it&rsquo;ll be along shortly.
          </p>
        </div>
        <div className="card">
          <Link href="/forgot" className="btn btn-block">
            Send a new link
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="shell shell-narrow">
      <div style={{ padding: "2rem 0 1rem" }}>
        <h1>Choose a new password</h1>
        <p className="muted">
          This signs you out everywhere else, so anyone still logged in on
          another device is kicked out.
        </p>
      </div>
      <ResetForm token={token} />
    </main>
  );
}
