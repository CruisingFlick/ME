"use client";

import { useActionState } from "react";
import { identifyCustomer } from "@/app/actions/customer";
import { SubmitButton } from "@/components/SubmitButton";

export function IdentifyForm({ slug, next }: { slug: string; next?: string }) {
  const [state, action] = useActionState(identifyCustomer, undefined);

  return (
    <form action={action} className="card">
      {state?.error && <div className="notice notice-error">{state.error}</div>}
      <input type="hidden" name="slug" value={slug} />
      {next && <input type="hidden" name="next" value={next} />}

      <div className="field">
        <label htmlFor="name">Your name or business</label>
        <input
          id="name"
          name="name"
          autoComplete="name"
          placeholder="e.g. Mick Farrell Electrical"
          required
        />
      </div>

      <div className="field">
        <label htmlFor="contact">Email or mobile</label>
        <input
          id="contact"
          name="contact"
          autoComplete="email"
          placeholder="mick@example.com.au or 0400 000 000"
          required
        />
        <p className="tiny" style={{ marginTop: "0.3rem" }}>
          So your rep can get back to you, and so this device remembers you next
          time.
        </p>
      </div>

      <div style={{ marginTop: "1rem" }}>
        <SubmitButton className="btn btn-block" pendingLabel="Just a sec…">
          Start a request
        </SubmitButton>
      </div>
    </form>
  );
}
