"use client";

import { useActionState } from "react";
import { completeReset } from "@/app/actions/password";
import { PasswordField } from "@/components/PasswordField";
import { SubmitButton } from "@/components/SubmitButton";

export function ResetForm({ token }: { token: string }) {
  const [state, action] = useActionState(completeReset, undefined);

  return (
    <form action={action} className="card">
      {state?.error && <div className="notice notice-error">{state.error}</div>}
      <input type="hidden" name="token" value={token} />

      <PasswordField
        name="password"
        label="New password"
        autoComplete="new-password"
        minLength={8}
        hint="At least 8 characters. Tap Show to check what you typed."
      />

      <PasswordField
        name="confirm"
        label="Type it again"
        autoComplete="new-password"
        minLength={8}
      />

      <div style={{ marginTop: "1rem" }}>
        <SubmitButton className="btn btn-block" pendingLabel="Saving…">
          Set new password
        </SubmitButton>
      </div>
    </form>
  );
}
