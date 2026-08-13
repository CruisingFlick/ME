"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signUpRep } from "@/app/actions/auth";
import { SubmitButton } from "@/components/SubmitButton";

export default function SignUpPage() {
  const [state, action] = useActionState(signUpRep, undefined);

  return (
    <main className="shell shell-narrow">
      <div style={{ padding: "2rem 0 1rem" }}>
        <h1>Create your rep account</h1>
        <p className="muted">
          One account per salesperson. Everything you add lives under it.
        </p>
      </div>

      <form action={action} className="card">
        {state?.error && <div className="notice notice-error">{state.error}</div>}

        <div className="field">
          <label htmlFor="name">Your name</label>
          <input id="name" name="name" autoComplete="name" required />
        </div>

        <div className="field">
          <label htmlFor="businessName">Display name for customers</label>
          <input
            id="businessName"
            name="businessName"
            placeholder="e.g. Dave — Tools &amp; Trade Supplies"
          />
          <p className="tiny" style={{ marginTop: "0.3rem" }}>
            Shown at the top of your customers&rsquo; screens, and used to build
            your invite link.
          </p>
        </div>

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
            autoComplete="new-password"
            minLength={8}
            required
          />
        </div>

        <div style={{ marginTop: "1rem" }}>
          <SubmitButton className="btn btn-block" pendingLabel="Creating…">
            Create account
          </SubmitButton>
        </div>
      </form>

      <p className="muted" style={{ textAlign: "center" }}>
        Already have one? <Link href="/login">Log in</Link>
      </p>
    </main>
  );
}
