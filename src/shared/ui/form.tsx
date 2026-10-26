"use client";

import { type ReactNode, useId } from "react";

const inputClass =
  "min-h-11 w-full rounded-lg border border-muted bg-surface px-3 text-base text-ink aria-invalid:border-red-700";

type TextFieldProps = {
  name: string;
  label: string;
  type?: "email" | "password" | "text" | "tel" | "date";
  autoComplete?: string;
  inputMode?: "text" | "numeric" | "email" | "tel";
  hint?: string;
  error?: string | null;
  required?: boolean;
  maxLength?: number;
  /**
   * Emails, passwords and codes are Latin and read left to right; a field that
   * only takes Arabic (with `lang="ar"`) reads right to left in either locale.
   */
  dir?: "ltr" | "rtl" | "auto";
  lang?: string;
  defaultValue?: string;
};

/** Ids for a field's hint and error, and the aria-describedby that joins them. */
function useFieldIds(hint?: string, error?: string | null) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") ||
    undefined;
  return { id, hintId, errorId, describedBy };
}

function FieldNotes({
  hint,
  hintId,
  error,
  errorId,
}: {
  hint?: string;
  hintId: string;
  error?: string | null;
  errorId: string;
}) {
  return (
    <>
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
    </>
  );
}

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
  lang,
  defaultValue,
}: TextFieldProps) {
  const { id, hintId, errorId, describedBy } = useFieldIds(hint, error);
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
        lang={lang}
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`${inputClass} text-start`}
      />
      <FieldNotes hint={hint} hintId={hintId} error={error} errorId={errorId} />
    </div>
  );
}

/** Multi-line text in either language; the browser picks the direction. */
export function TextAreaField({
  name,
  label,
  hint,
  error,
  maxLength,
  defaultValue,
  required = false,
  rows = 5,
}: {
  name: string;
  label: string;
  hint?: string;
  error?: string | null;
  maxLength?: number;
  defaultValue?: string;
  required?: boolean;
  rows?: number;
}) {
  const { id, hintId, errorId, describedBy } = useFieldIds(hint, error);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-semibold text-ink">
        {label}
      </label>
      <textarea
        id={id}
        name={name}
        rows={rows}
        maxLength={maxLength}
        required={required}
        dir="auto"
        defaultValue={defaultValue}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className="w-full rounded-lg border border-muted bg-surface px-3 py-2 text-start text-base text-ink aria-invalid:border-red-700"
      />
      <FieldNotes hint={hint} hintId={hintId} error={error} errorId={errorId} />
    </div>
  );
}

export function SelectField({
  name,
  label,
  options,
  placeholder,
  hint,
  error,
  defaultValue,
  required = true,
}: {
  name: string;
  label: string;
  options: readonly { value: string; label: string }[];
  /** Shown as an empty first option. */
  placeholder?: string;
  hint?: string;
  error?: string | null;
  defaultValue?: string;
  required?: boolean;
}) {
  const { id, hintId, errorId, describedBy } = useFieldIds(hint, error);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-semibold text-ink">
        {label}
      </label>
      <select
        id={id}
        name={name}
        required={required}
        defaultValue={defaultValue ?? ""}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`${inputClass} text-start`}
      >
        {placeholder !== undefined ? (
          <option value="">{placeholder}</option>
        ) : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <FieldNotes hint={hint} hintId={hintId} error={error} errorId={errorId} />
    </div>
  );
}

const choiceClass =
  "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-1 text-ink";
const boxClass = "size-5 shrink-0 accent-primary";

export function CheckboxField({
  name,
  label,
  defaultChecked,
  onChange,
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  return (
    <label className={choiceClass}>
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        onChange={onChange ? (e) => onChange(e.target.checked) : undefined}
        className={boxClass}
      />
      <span>{label}</span>
    </label>
  );
}

/** A group of checkboxes (several values) or radios (one value). */
export function ChoiceGroup({
  name,
  legend,
  type,
  options,
  defaultValues = [],
  hint,
  error,
  onChange,
}: {
  name: string;
  legend: string;
  type: "checkbox" | "radio";
  options: readonly { value: string; label: string; hint?: string }[];
  defaultValues?: readonly string[];
  hint?: string;
  error?: string | null;
  /** Called with the option's value when it is checked. */
  onChange?: (value: string) => void;
}) {
  const { hintId, errorId, describedBy } = useFieldIds(hint, error);
  return (
    <fieldset
      className="flex flex-col gap-1"
      aria-describedby={describedBy}
      aria-invalid={error ? true : undefined}
    >
      <legend className="mb-1 font-semibold text-ink">{legend}</legend>
      {options.map((o) => (
        <label key={o.value} className={choiceClass}>
          <input
            type={type}
            name={name}
            value={o.value}
            defaultChecked={defaultValues.includes(o.value)}
            onChange={
              onChange
                ? (e) => {
                    if (e.target.checked) onChange(o.value);
                  }
                : undefined
            }
            className={boxClass}
          />
          <span className="flex flex-col">
            <span>{o.label}</span>
            {o.hint ? (
              <span className="text-sm text-muted">{o.hint}</span>
            ) : null}
          </span>
        </label>
      ))}
      <FieldNotes hint={hint} hintId={hintId} error={error} errorId={errorId} />
    </fieldset>
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
  tone = "primary",
}: {
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  /** "danger" for destructive actions such as delete. */
  tone?: "primary" | "danger";
}) {
  const colors =
    tone === "danger"
      ? "border-red-700 text-red-700 hover:bg-red-700"
      : "border-primary text-primary hover:bg-primary";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-11 items-center justify-center rounded-lg border px-5 font-semibold hover:text-white disabled:opacity-70 ${colors}`}
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
