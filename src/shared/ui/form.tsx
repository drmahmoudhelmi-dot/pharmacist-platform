"use client";

import { type ReactNode, useId } from "react";

const inputClass =
  "min-h-11 w-full rounded-lg border border-muted bg-surface px-3 text-base text-ink aria-invalid:border-red-700";

type TextFieldProps = {
  name: string;
  label: string;
  type?: "email" | "password" | "text";
  autoComplete?: string;
  inputMode?: "text" | "numeric" | "email";
  hint?: string;
  error?: string | null;
  required?: boolean;
  maxLength?: number;
  /** Emails, passwords and codes are Latin and read left to right. */
  dir?: "ltr" | "auto";
};

export function TextField({
  name,
  label,
  type = "text",
  autoComplete,
  inputMode,
  hint,
  error,
  required = true,
  maxLength,
  dir = "ltr",
}: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") ||
    undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-semibold text-ink">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        autoComplete={autoComplete}
        inputMode={inputMode}
        required={required}
        maxLength={maxLength}
        dir={dir}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`${inputClass} text-start`}
      />
      {hint ? (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm font-semibold text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SubmitButton({
  pending,
  label,
  pendingLabel,
}: {
  pending: boolean;
  label: string;
  pendingLabel: string;
}) {
  return (
    <button
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      className="inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-5 font-semibold text-white hover:bg-primary-strong disabled:opacity-70"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

export function SecondaryButton({
  onClick,
  children,
  disabled,
}: {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex min-h-11 items-center justify-center rounded-lg border border-primary px-5 font-semibold text-primary hover:bg-primary hover:text-white disabled:opacity-70"
    >
      {children}
    </button>
  );
}

/**
 * Always rendered so screen readers announce changes. Errors use an alert
 * role; successes and progress use a polite status.
 */
export function FormStatus({
  error,
  success,
}: {
  error?: string | null;
  success?: string | null;
}) {
  return (
    <div aria-live="polite" className="empty:hidden">
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-red-700 bg-red-50 p-3 text-red-800"
        >
          {error}
        </p>
      ) : success ? (
        <p
          role="status"
          className="rounded-lg border border-primary bg-teal-50 p-3 text-primary-strong"
        >
          {success}
        </p>
      ) : null}
    </div>
  );
}
