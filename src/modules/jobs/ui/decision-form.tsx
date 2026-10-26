"use client";

import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState } from "react";
import { useRouter } from "@/shared/i18n/navigation";
import {
  FormStatus,
  SelectField,
  SubmitButton,
  TextAreaField,
} from "@/shared/ui/form";
import { decideJobAction } from "../actions";
import { LIMITS, REJECT_REASONS } from "../constants";
import {
  type DecisionField,
  type FieldErrors,
  formDataToRaw,
  parseDecision,
} from "../validation";

type Decision = "approved" | "rejected";

/** Approve, or reject with a reason; a second click confirms. */
export function JobDecisionForm({ jobId }: { jobId: string }) {
  const t = useTranslations("StaffJobs");
  const tr = useTranslations("JobRejectReasons");
  const te = useTranslations("JobErrors");
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
      const result = await decideJobAction(jobId, form);
      if (result.ok) {
        setSuccess(t(`decided.${local.data.decision}`));
        router.push("/staff/jobs");
        router.refresh();
      } else {
        setConfirming(false);
        setFieldErrors(("fieldErrors" in result && result.fieldErrors) || {});
        setError(te(result.error));
      }
    } catch {
      setConfirming(false);
      setError(te("network"));
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
      data-testid="job-decision-form"
    >
      <fieldset
        className="flex flex-col gap-1"
        aria-labelledby={legendId}
        aria-invalid={fieldErrors.decision ? true : undefined}
      >
        <legend id={legendId} className="mb-1 font-semibold text-ink">
          {t("decisionLabel")}
        </legend>
        {(["approved", "rejected"] as const).map((value) => (
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
      {decision === "rejected" ? (
        <SelectField
          name="reasonCode"
          label={t("reasonLabel")}
          placeholder={t("reasonPlaceholder")}
          options={REJECT_REASONS.map((code) => ({
            value: code,
            label: tr(code),
          }))}
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
