"use client";

import { useActionState } from "react";
import {
  cancelPendingCode,
  identifyCustomer,
  submitCode,
} from "@/app/actions/customer";
import { SubmitButton } from "@/components/SubmitButton";

export function IdentifyForm({ slug, next }: { slug: string; next?: string }) {
  const [state, action] = useActionState(identifyCustomer, undefined);

  if (state && "needsRepLink" in state) {
    return (
      <div className="card">
        <div className="notice notice-warn">
          We can only send a code to an email address.
        </div>
        <p className="muted">
          You&rsquo;ve ordered before, so we need to check it&rsquo;s really
          you before showing your history. Ask {state.repName} to send you a
          sign-in link — it takes them one tap.
        </p>
        <form action={cancelPendingCode}>
          <input type="hidden" name="slug" value={slug} />
          <SubmitButton className="btn btn-secondary">Start again</SubmitButton>
        </form>
      </div>
    );
  }

  if (state && "needsCode" in state) {
    return <CodeStep slug={slug} sentTo={state.sentTo} />;
  }

  return (
    <form action={action} className="card">
      {state && "error" in state && (
        <div className="notice notice-error">{state.error}</div>
      )}
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

function CodeStep({ slug, sentTo }: { slug: string; sentTo: string }) {
  const [state, action] = useActionState(submitCode, undefined);

  return (
    <>
      <form action={action} className="card">
        {state?.error && <div className="notice notice-error">{state.error}</div>}

        <p className="muted">
          You&rsquo;ve ordered before, so we sent a 6-digit code to{" "}
          <strong>{sentTo}</strong> to check it&rsquo;s you. This only happens on
          a device we haven&rsquo;t seen.
        </p>

        <div className="field">
          <label htmlFor="code">Your code</label>
          <input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            placeholder="000000"
            className="code-input"
            required
            autoFocus
          />
        </div>

        <div style={{ marginTop: "1rem" }}>
          <SubmitButton className="btn btn-block" pendingLabel="Checking…">
            Confirm it&rsquo;s me
          </SubmitButton>
        </div>
      </form>

      <form action={cancelPendingCode} style={{ textAlign: "center" }}>
        <input type="hidden" name="slug" value={slug} />
        <button type="submit" className="btn-ghost">
          Use a different email
        </button>
      </form>
    </>
  );
}
