import Link from "next/link";

export default function LinkExpiredPage() {
  return (
    <main className="shell shell-narrow">
      <div style={{ padding: "2rem 0 1rem" }}>
        <h1>That link has expired</h1>
        <p className="muted">
          Sign-in links last a day and are meant for one person. Ask your rep
          for a fresh one — it takes them a moment.
        </p>
      </div>
      <div className="card">
        <p className="muted" style={{ marginBottom: 0 }}>
          <Link href="/">Back to the start</Link>
        </p>
      </div>
    </main>
  );
}
