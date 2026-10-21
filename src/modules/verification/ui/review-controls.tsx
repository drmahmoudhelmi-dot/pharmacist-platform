"use client";

import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState } from "react";
import { useRouter } from "@/shared/i18n/navigation";
import {
  FormStatus,
  SecondaryButton,
  SelectField,
  SubmitButton,
  TextAreaField,
} from "@/shared/ui/form";
import { decideAction, revealNationalIdAction } from "../actions";
import { type Decision, LIMITS, REASONS_FOR } from "../constants";
import {
  type DecisionField,
  type FieldErrors,
  formDataToRaw,
  parseDecision,
} from "../validation";

/**
 * Masked by default. Revealing asks the server, which logs the reveal before
 * answering; the value is kept in component state only and goes away with
 * the page.
 */
export function RevealNationalId({
  submissionId,
  masked,
}: {
  submissionId: string;
  masked: string;
}) {
  const t = useTranslations("StaffVerification");
  const [value, setValue] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reveal() {
    setPending(true);
    setError(null);
    try {
      const result = await revealNationalIdAction(submissionId);
      if (result.ok) setValue(result.nationalId);
      else setError(t(`errors.${result.error}`));
    } catch {
      setError(t("errors.unavailable"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p>
        {t("nationalIdLabel")}:{" "}
        <bdi
          dir="ltr"
          className="font-mono text-lg"
          data-testid="review-national-id"
        >
          {value ?? masked}
        </bdi>
      </p>
      {value ? (
        <SecondaryButton onClick={() => setValue(null)}>
          {t("hideNationalId")}
        </SecondaryButton>
      ) : (
        <>
          <p className="text-sm text-muted">{t("revealExplain")}</p>
          <SecondaryButton onClick={reveal} disabled={pending}>
            {pending ? t("working") : t("revealNationalId")}
          </SecondaryButton>
        </>
      )}
      <FormStatus error={error} />
    </div>
  );
}

/** Approve or reject with a reason; a second click confirms. */
export function DecisionForm({ submissionId }: { submissionId: string }) {
  const t = useTranslations("StaffVerification");
  const tr = useTranslations("VerificationReasons");
  const te = useTranslations("VerificationErrors");
  const router = useRouter();
  const legendId = useId();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<DecisionField>>(
    {},
  );

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    const local = parseDecision(formDataToRaw(form));
    if (!local.ok) {
      setFieldErrors(local.fieldErrors);
      setError(te("validation"));
      return;
    }
    setFieldErrors({});
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setPending(true);
    try {
      const result = await decideAction(submissionId, form);
      if (result.ok) {
        setSuccess(t(`decided.${result.status}`));
        router.refresh();
      } else {
        setConfirming(false);
        setFieldErrors(("fieldErrors" in result && result.fieldErrors) || {});
        setError(t(`errors.${result.error}`));
      }
    } catch {
      setConfirming(false);
      setError(t("errors.unavailable"));
    } finally {
      setPending(false);
    }
  }

  if (success) return <FormStatus success={success} />;

  const fieldError = (key: DecisionField) => {
    const code = fieldErrors[key];
    return code ? te(code) : undefined;
  };

  return (
    <form
      noValidate
      onSubmit={onSubmit}
      className="flex flex-col gap-4"
      data-testid="decision-form"
    >
      <fieldset
        className="flex flex-col gap-1"
        aria-labelledby={legendId}
        aria-invalid={fieldErrors.decision ? true : undefined}
      >
        <legend id={legendId} className="mb-1 font-semibold text-ink">
          {t("decisionLabel")}
        </legend>
        {(["verified", "rejected"] as const).map((value) => (
          <label
            key={value}
            className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-1 text-ink"
          >
            <input
              type="radio"
              name="decision"
              value={value}
              onChange={() => {
                setDecision(value);
                setConfirming(false);
              }}
              className="size-5 shrink-0 accent-primary"
            />
            <span>{t(`decisions.${value}`)}</span>
          </label>
        ))}
        {fieldErrors.decision ? (
          <p className="text-sm font-semibold text-red-700">
            {fieldError("decision")}
          </p>
        ) : null}
      </fieldset>
      {decision ? (
        <SelectField
          key={decision}
          name="reasonCode"
          label={t("reasonLabel")}
          placeholder={t("reasonPlaceholder")}
          options={REASONS_FOR[decision].map((code) => ({
            value: code,
            label: tr(code),
          }))}
          defaultValue={decision === "verified" ? "documents_match" : ""}
          error={fieldError("reasonCode")}
        />
      ) : null}
      <TextAreaField
        name="note"
        label={t("noteLabel")}
        hint={t("noteHint")}
        maxLength={LIMITS.note.max}
        rows={3}
        error={fieldError("note")}
      />
      {confirming && decision ? (
        <p
          role="alert"
          className="rounded-lg border border-amber-700 bg-amber-50 p-3 text-amber-900"
        >
          {t(`confirm.${decision}`)}
        </p>
      ) : null}
      <FormStatus error={error} />
      <SubmitButton
        pending={pending}
        label={
          confirming && decision
            ? t(`confirmButton.${decision}`)
            : t("submitDecision")
        }
        pendingLabel={t("working")}
      />
    </form>
  );
}
