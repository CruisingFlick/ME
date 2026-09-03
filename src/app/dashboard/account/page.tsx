import { requireRep } from "@/lib/rep-session";
import { logOutEverywhere } from "@/app/actions/auth";
import { SubmitButton } from "@/components/SubmitButton";
import { ChangePasswordForm } from "./ChangePasswordForm";

export default async function AccountPage() {
  const rep = await requireRep();

  return (
    <main className="shell shell-narrow">
      <div style={{ padding: "1.25rem 0 0.5rem" }}>
        <h1>Your account</h1>
        <p className="muted">
          {rep.name} · {rep.email}
        </p>
      </div>

      <section className="card">
        <h2>Change your password</h2>
        <p className="muted">
          You&rsquo;ll stay logged in here. Everywhere else gets signed out.
        </p>
        <ChangePasswordForm />
      </section>

      <section className="card">
        <h2>Signed in somewhere else?</h2>
        <p className="muted">
          Signs you out on every device — an old phone, a shared computer, a
          browser you can&rsquo;t get back to. You&rsquo;ll log in again here.
        </p>
        <form action={logOutEverywhere}>
          <SubmitButton className="btn btn-secondary" pendingLabel="Signing out…">
            Sign out everywhere
          </SubmitButton>
        </form>
      </section>
    </main>
  );
}
