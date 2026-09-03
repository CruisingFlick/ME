"use client";

import { useActionState } from "react";
import { changePassword } from "@/app/actions/password";
import { PasswordField } from "@/components/PasswordField";
import { SubmitButton } from "@/components/SubmitButton";

export function ChangePasswordForm() {
  const [state, action] = useActionState(changePassword, undefined);

  return (
    <form action={action}>
      {state && "error" in state && (
        <div className="notice notice-error">{state.error}</div>
      )}
      {state && "changed" in state && (
        <div className="notice notice-ok">
          Password changed. Any other device you were logged in on has been
          signed out.
        </div>
      )}

      <PasswordField
        name="current"
        label="Current password"
        autoComplete="current-password"
      />

      <PasswordField
        name="password"
        label="New password"
        autoComplete="new-password"
        minLength={8}
        hint="At least 8 characters. Tap Show to check what you typed."
      />

      <PasswordField
        name="confirm"
        label="Type the new one again"
        autoComplete="new-password"
        minLength={8}
      />

      <div style={{ marginTop: "1rem" }}>
        <SubmitButton pendingLabel="Saving…">Change password</SubmitButton>
      </div>
    </form>
  );
}
