"use client";

import { useTranslations } from "next-intl";
import { type FormEvent } from "react";
import {
  FormStatus,
  SelectField,
  SubmitButton,
  TextAreaField,
} from "@/shared/ui/form";
import { reportJobAction } from "../actions";
import { REPORT_LIMITS, REPORT_REASONS } from "../constants";
import { formDataToRaw, parseReport, type ReportField } from "../validation";
import { useWrite } from "./use-write";

/** Report a live job: a reason and optional details. The server decides. */
export function ReportForm({ jobId }: { jobId: string }) {
  const t = useTranslations("JobReport");
  const tr = useTranslations("ReportReasons");
  const write = useWrite<ReportField>();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const local = parseReport(formDataToRaw(form));
    await write.submit(
      local.ok ? null : local.fieldErrors,
      () => reportJobAction(jobId, form),
      t("sent"),
    );
  }

  return (
    <form
      noValidate
      onSubmit={onSubmit}
      className="flex flex-col gap-4"
      data-testid="report-form"
    >
      <SelectField
        name="reasonCode"
        label={t("reasonLabel")}
        placeholder={t("reasonPlaceholder")}
        options={REPORT_REASONS.map((c) => ({ value: c, label: tr(c) }))}
        error={write.fieldError("reasonCode")}
      />
      <TextAreaField
        name="details"
        label={t("detailsLabel")}
        hint={t("detailsHint")}
        maxLength={REPORT_LIMITS.details.max}
        rows={3}
        error={write.fieldError("details")}
      />
      <FormStatus error={write.error} success={write.success} />
      <SubmitButton
        pending={write.pending}
        label={t("submit")}
        pendingLabel={t("sending")}
      />
    </form>
  );
}
