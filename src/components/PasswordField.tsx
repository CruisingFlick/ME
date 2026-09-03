"use client";

import { useId, useState } from "react";

/**
 * Password input with a reveal toggle.
 *
 * Being able to see what you typed prevents more lockouts than hiding it
 * prevents shoulder-surfing — especially on a phone keyboard on a work site.
 * It starts masked and the choice is never persisted.
 */
export function PasswordField({
  name,
  label,
  autoComplete,
  minLength,
  required = true,
  hint,
}: {
  name: string;
  label: string;
  autoComplete: "current-password" | "new-password";
  minLength?: number;
  required?: boolean;
  hint?: string;
}) {
  const [shown, setShown] = useState(false);
  const id = useId();

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="password-row">
        <input
          id={id}
          name={name}
          type={shown ? "text" : "password"}
          autoComplete={autoComplete}
          minLength={minLength}
          required={required}
          className="grow"
          // Stop mobile keyboards "helpfully" altering a typed password.
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <button
          type="button"
          className="btn btn-secondary password-toggle"
          onClick={() => setShown((s) => !s)}
          // The label says what will happen; the pressed state says where we are.
          aria-pressed={shown}
          aria-label={shown ? "Hide password" : "Show password"}
        >
          {shown ? "Hide" : "Show"}
        </button>
      </div>
      {hint && (
        <p className="tiny" style={{ marginTop: "0.3rem" }}>
          {hint}
        </p>
      )}
    </div>
  );
}
