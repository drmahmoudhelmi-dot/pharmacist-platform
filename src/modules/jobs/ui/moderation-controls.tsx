"use client";

import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { useRouter } from "@/shared/i18n/navigation";
import {
  FormStatus,
  SecondaryButton,
  SelectField,
  SubmitButton,
  TextAreaField,
} from "@/shared/ui/form";
import { dismissReportsAction, removeJobAction } from "../actions";
import { LIMITS, REMOVE_REASONS } from "../constants";
import { formDataToRaw, parseRemoval, type RemovalField } from "../validation";
import { useWrite } from "./use-write";

/** Dismiss every open report of a job, after a confirmation. */
export function DismissReportsButton({ jobId }: { jobId: string }) {
  const t = useTranslations("StaffReports");
  const write = useWrite();
  const [confirming, setConfirming] = useState(false);

  async function dismiss() {
    setConfirming(false);
    await write.submit(null, () => dismissReportsAction(jobId), t("dismissed"));
  }

  return (
    <div className="flex flex-col gap-3" data-testid="dismiss-reports">
      {confirming ? (
        <div className="flex flex-col gap-2" role="group">
          <p>{t("dismissConfirm")}</p>
          <div className="flex flex-wrap gap-2">
            <SecondaryButton
              tone="danger"
              disabled={write.pending}
              onClick={dismiss}
            >
              {t("confirmDismiss")}
            </SecondaryButton>
            <SecondaryButton onClick={() => setConfirming(false)}>
              {t("cancel")}
            </SecondaryButton>
          </div>
        </div>
      ) : (
        <div>
          <SecondaryButton
            disabled={write.pending}
            onClick={() => setConfirming(true)}
          >
            {t("dismiss")}
          </SecondaryButton>
        </div>
      )}
      <FormStatus error={write.error} success={write.success} />
    </div>
  );
}

/** Take a live job down with a reason and an internal note; a second click confirms. */
export function RemoveJobForm({ jobId }: { jobId: string }) {
  const t = useTranslations("StaffReports");
  const tr = useTranslations("JobRejectReasons");
  const router = useRouter();
  const write = useWrite<RemovalField>();
  const [confirming, setConfirming] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const local = parseRemoval(formDataToRaw(form));
    if (!local.ok) {
      setConfirming(false);
      await write.submit(
        local.fieldErrors,
        () => removeJobAction(jobId, form),
        "",
      );
      return;
    }
    if (!confirming) {
      setConfirming(true);
      return;
    }
    const result = await write.submit(
      null,
      () => removeJobAction(jobId, form),
      t("removed"),
    );
    setConfirming(false);
    if (result?.ok) router.push("/staff/reports");
  }

  return (
    <form
      noValidate
      onSubmit={onSubmit}
      className="flex flex-col gap-4"
      data-testid="remove-job-form"
    >
      <SelectField
        name="reasonCode"
        label={t("reasonLabel")}
        placeholder={t("reasonPlaceholder")}
        options={REMOVE_REASONS.map((c) => ({ value: c, label: tr(c) }))}
        error={write.fieldError("reasonCode")}
      />
      <TextAreaField
        name="note"
        label={t("noteLabel")}
        hint={t("noteHint")}
        maxLength={LIMITS.note.max}
        rows={3}
        error={write.fieldError("note")}
      />
      {confirming ? (
        <p
          role="alert"
          className="rounded-lg border border-amber-700 bg-amber-50 p-3 text-amber-900"
        >
          {t("removeConfirm")}
        </p>
      ) : null}
      <FormStatus error={write.error} success={write.success} />
      <SubmitButton
        pending={write.pending}
        label={confirming ? t("confirmRemove") : t("remove")}
        pendingLabel={t("working")}
      />
    </form>
  );
}
