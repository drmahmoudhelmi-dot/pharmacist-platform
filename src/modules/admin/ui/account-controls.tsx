"use client";

import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import {
  LIFT_REASONS,
  SUSPENSION_LIMITS,
  SUSPENSION_REASONS,
} from "@/modules/identity/suspension-constants";
import { useRouter } from "@/shared/i18n/navigation";
import {
  FormStatus,
  SecondaryButton,
  SelectField,
  SubmitButton,
  TextAreaField,
} from "@/shared/ui/form";
import { reinstateAccountAction, suspendAccountAction } from "../actions";

/**
 * Suspend (with a reason, an internal note and a confirmation) or reinstate
 * (with a reason) one account. Shown only when the server says the actor may
 * act; the service checks again on every call.
 */
export function AccountControls({
  userId,
  suspended,
}: {
  userId: string;
  suspended: boolean;
}) {
  const t = useTranslations("StaffAccounts");
  const te = useTranslations("StaffAccountErrors");
  const ts = useTranslations("SuspensionReasons");
  const tl = useTranslations("LiftReasons");
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(null);
    setSuccess(null);
    if (!form.get("reasonCode")) {
      setReasonError(te("reasonRequired"));
      return;
    }
    setReasonError(null);
    if (!suspended && !confirming) {
      setConfirming(true);
      return;
    }
    setPending(true);
    try {
      const result = suspended
        ? await reinstateAccountAction(userId, form)
        : await suspendAccountAction(userId, form);
      setConfirming(false);
      if (result.ok) {
        setSuccess(t(suspended ? "reinstated" : "suspendedDone"));
        router.refresh();
      } else {
        setError(te(result.error));
      }
    } catch {
      setConfirming(false);
      setError(te("network"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      noValidate
      onSubmit={onSubmit}
      // A fresh form (and select) after the state flips.
      key={suspended ? "reinstate" : "suspend"}
      className="flex flex-col gap-4"
      data-testid={suspended ? "reinstate-form" : "suspend-form"}
    >
      <h2 className="text-xl font-bold">
        {suspended ? t("reinstateHeading") : t("suspendHeading")}
      </h2>
      <SelectField
        name="reasonCode"
        label={suspended ? t("liftReasonLabel") : t("reasonLabel")}
        placeholder={t("reasonPlaceholder")}
        error={reasonError}
        options={
          suspended
            ? LIFT_REASONS.map((c) => ({ value: c, label: tl(c) }))
            : SUSPENSION_REASONS.map((c) => ({ value: c, label: ts(c) }))
        }
      />
      {suspended ? null : (
        <TextAreaField
          name="note"
          label={t("noteLabel")}
          hint={t("noteHint")}
          maxLength={SUSPENSION_LIMITS.note.max}
          rows={3}
        />
      )}
      {confirming ? (
        <div className="flex flex-col gap-2">
          <p
            role="alert"
            className="rounded-lg border border-amber-700 bg-amber-50 p-3 text-amber-900"
          >
            {t("suspendConfirm")}
          </p>
          <SecondaryButton onClick={() => setConfirming(false)}>
            {t("cancel")}
          </SecondaryButton>
        </div>
      ) : null}
      <FormStatus error={error} success={success} />
      <SubmitButton
        pending={pending}
        label={
          suspended
            ? t("reinstate")
            : confirming
              ? t("confirmSuspend")
              : t("suspend")
        }
        pendingLabel={t("working")}
      />
    </form>
  );
}
