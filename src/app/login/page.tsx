"use client";

import Link from "next/link";
import { useActionState } from "react";
import { logInRep } from "@/app/actions/auth";
import { SubmitButton } from "@/components/SubmitButton";

export default function LogInPage() {
  const [state, action] = useActionState(logInRep, undefined);

  return (
    <main className="shell shell-narrow">
      <div style={{ padding: "2rem 0 1rem" }}>
        <h1>Log in</h1>
      </div>

      <form action={action} className="card">
        {state?.error && <div className="notice notice-error">{state.error}</div>}

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

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>

        <div style={{ marginTop: "1rem" }}>
          <SubmitButton className="btn btn-block" pendingLabel="Logging in…">
            Log in
          </SubmitButton>
        </div>
      </form>

      <p className="muted" style={{ textAlign: "center" }}>
        No account yet? <Link href="/signup">Create one</Link>
      </p>
    </main>
  );
}
