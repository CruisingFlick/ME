"use client";

import Link from "next/link";
import { useActionState } from "react";
import { requestReset } from "@/app/actions/password";
import { SubmitButton } from "@/components/SubmitButton";

export default function ForgotPage() {
  const [state, action] = useActionState(requestReset, undefined);

  const sent = state && "sent" in state;

  return (
    <main className="shell shell-narrow">
      <div style={{ padding: "2rem 0 1rem" }}>
        <h1>Reset your password</h1>
        <p className="muted">
          Put in the email address on your account and we&rsquo;ll send you a
          link to choose a new password.
        </p>
      </div>

      {sent ? (
        <div className="card">
          <div className="notice notice-ok">
            If that email has an account, a reset link is on its way. It works
            once and expires in an hour.
          </div>

          {/* Shown only when no email provider is configured on this
              deployment — see the note in actions/password.ts. */}
          {state.manualLink && (
            <>
              <p className="muted">
                This deployment has no email provider set up, so here is the
                link directly:
              </p>
              <input
                readOnly
                value={state.manualLink}
                onFocus={(e) => e.currentTarget.select()}
                aria-label="Your reset link"
              />
            </>
          )}

          <p className="muted" style={{ marginTop: "1rem", marginBottom: 0 }}>
            <Link href="/login">Back to log in</Link>
          </p>
        </div>
      ) : (
        <form action={action} className="card">
          {state && "error" in state && (
            <div className="notice notice-error">{state.error}</div>
          )}

          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
            />
          </div>

          <div style={{ marginTop: "1rem" }}>
            <SubmitButton className="btn btn-block" pendingLabel="Sending…">
              Send me a reset link
            </SubmitButton>
          </div>
        </form>
      )}

      {!sent && (
        <p className="muted" style={{ textAlign: "center" }}>
          <Link href="/login">Back to log in</Link>
        </p>
      )}
    </main>
  );
}
