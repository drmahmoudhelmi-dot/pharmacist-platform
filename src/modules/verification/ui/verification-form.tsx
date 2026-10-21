"use client";

import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState } from "react";
import { useRouter } from "@/shared/i18n/navigation";
import {
  ChoiceGroup,
  FormStatus,
  SubmitButton,
  TextField,
} from "@/shared/ui/form";
import { submitVerificationAction } from "../actions";
import {
  type CredentialType,
  type DocumentKind,
  LIMITS,
  REQUIRED_DOCUMENTS,
} from "../constants";
import {
  type FieldErrors,
  formDataToRaw,
  parseSubmission,
  type SubmissionField,
} from "../validation";
import { DocumentUpload } from "./document-upload";

/**
 * The verification request form. Validates in the browser for fast feedback;
 * the server action's result alone decides success. The national ID is sent
 * once, over the form post, and never stored in the browser.
 */
export function VerificationForm() {
  const t = useTranslations("Verification");
  const te = useTranslations("VerificationErrors");
  const router = useRouter();
  const expiryId = useId();
  const consentId = useId();
  const [type, setType] = useState<CredentialType>("pharmacist");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors<SubmissionField>>(
    {},
  );

  const fieldError = (key: SubmissionField) => {
    const code = fieldErrors[key];
    return code ? te(code) : undefined;
  };

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setError(null);
    setSuccess(null);
    const local = parseSubmission(formDataToRaw(form), new Date());
    if (!local.ok) {
      setFieldErrors(local.fieldErrors);
      setError(te("validation"));
      return;
    }
    setFieldErrors({});
    setPending(true);
    try {
      const result = await submitVerificationAction(form);
      if (result.ok) {
        setSuccess(
          t("submitted", { masked: result.submission.nationalIdMasked }),
        );
        formElement.reset();
        router.refresh();
      } else {
        setFieldErrors(("fieldErrors" in result && result.fieldErrors) || {});
        setError(te(result.error));
      }
    } catch {
      setError(te("network"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      noValidate
      onSubmit={onSubmit}
      className="flex flex-col gap-4"
      data-testid="verification-form"
    >
      <ChoiceGroup
        name="credentialType"
        legend={t("credentialTypeLabel")}
        type="radio"
        defaultValues={["pharmacist"]}
        options={(["pharmacist", "student"] as const).map((value) => ({
          value,
          label: t(`credentialTypes.${value}`),
          hint: t(`credentialHints.${value}`),
        }))}
        error={fieldError("credentialType")}
        onChange={(value) => setType(value as CredentialType)}
      />
      <TextField
        name="nationalId"
        label={t("nationalIdLabel")}
        hint={t("nationalIdHint")}
        inputMode="numeric"
        autoComplete="off"
        maxLength={24}
        error={fieldError("nationalId")}
      />
      {type === "pharmacist" ? (
        <TextField
          key="syndicate"
          name="syndicateNumber"
          label={t("syndicateNumberLabel")}
          hint={t("syndicateNumberHint")}
          inputMode="numeric"
          autoComplete="off"
          maxLength={LIMITS.syndicateNumber.max + 4}
          error={fieldError("syndicateNumber")}
        />
      ) : (
        <TextField
          key="university"
          name="university"
          label={t("universityLabel")}
          dir="auto"
          maxLength={LIMITS.university.max}
          error={fieldError("university")}
        />
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor={expiryId} className="font-semibold text-ink">
          {t("cardExpiresOnLabel")}
        </label>
        <p id={`${expiryId}-hint`} className="text-sm text-muted">
          {t("cardExpiresOnHint")}
        </p>
        <input
          id={expiryId}
          name="cardExpiresOn"
          type="date"
          dir="ltr"
          aria-describedby={`${expiryId}-hint${fieldErrors.cardExpiresOn ? ` ${expiryId}-error` : ""}`}
          aria-invalid={fieldErrors.cardExpiresOn ? true : undefined}
          className="min-h-11 w-full rounded-lg border border-muted bg-surface px-3 text-start text-base text-ink aria-invalid:border-red-700"
        />
        {fieldErrors.cardExpiresOn ? (
          <p
            id={`${expiryId}-error`}
            className="text-sm font-semibold text-red-700"
          >
            {fieldError("cardExpiresOn")}
          </p>
        ) : null}
      </div>
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 font-semibold text-ink">
          {t("documentsLegend")}
        </legend>
        <p className="text-sm text-muted">{t("documentsHint")}</p>
        {REQUIRED_DOCUMENTS[type].map((kind: DocumentKind) => (
          <DocumentUpload
            key={kind}
            kind={kind}
            label={t(`documentKinds.${kind}`)}
            hint={t(`documentHints.${kind}`)}
            serverError={fieldError(kind)}
          />
        ))}
      </fieldset>
      <div className="flex flex-col gap-2 rounded-lg border-2 border-dashed border-muted p-3">
        <p className="w-fit rounded bg-ink px-2 py-1 text-sm text-white">
          {t("consentPendingBadge")}
        </p>
        <p className="text-sm" id={`${consentId}-text`}>
          {t("consentText")}
        </p>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-1 text-ink">
          <input
            id={consentId}
            type="checkbox"
            name="consent"
            aria-describedby={`${consentId}-text`}
            aria-invalid={fieldErrors.consent ? true : undefined}
            className="size-5 shrink-0 accent-primary"
          />
          <span>{t("consentLabel")}</span>
        </label>
        {fieldErrors.consent ? (
          <p className="text-sm font-semibold text-red-700">
            {fieldError("consent")}
          </p>
        ) : null}
      </div>
      <FormStatus error={error} success={success} />
      <SubmitButton
        pending={pending}
        label={t("submit")}
        pendingLabel={t("submitting")}
      />
    </form>
  );
}
