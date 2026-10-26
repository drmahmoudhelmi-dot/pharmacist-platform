"use client";

import { useLocale, useTranslations } from "next-intl";
import { type FormEvent } from "react";
import { Link } from "@/shared/i18n/navigation";
import {
  CheckboxField,
  FormStatus,
  SubmitButton,
  TextAreaField,
} from "@/shared/ui/form";
import { applyToJobAction } from "../actions";
import { APPLICATION_LIMITS } from "../constants";
import { formDataToRaw, parseApplication } from "../validation";
import { formatCount } from "./format";
import { useApplicationWrite } from "./use-application-write";

/**
 * The application form on the job page: an optional note and, only when the
 * applicant has a phone saved, a tick to share it. The server decides.
 */
export function ApplyForm({
  jobId,
  canSharePhone,
}: {
  jobId: string;
  canSharePhone: boolean;
}) {
  const t = useTranslations("Applications");
  const locale = useLocale();
  const write = useApplicationWrite<"coverNote", { applicationId: string }>();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const local = parseApplication(formDataToRaw(form));
    await write.submit(
      local.ok ? null : local.fieldErrors,
      () => applyToJobAction(jobId, form),
      t("applied"),
    );
  }

  return (
    <form
      noValidate
      onSubmit={onSubmit}
      className="flex flex-col gap-4"
      data-testid="apply-form"
    >
      <TextAreaField
        name="coverNote"
        label={t("coverNoteLabel")}
        hint={t("coverNoteHint", {
          max: formatCount(APPLICATION_LIMITS.coverNote.max, locale),
        })}
        maxLength={APPLICATION_LIMITS.coverNote.max}
        rows={4}
        error={write.fieldError("coverNote")}
      />
      {canSharePhone ? (
        <CheckboxField name="sharePhone" label={t("sharePhoneLabel")} />
      ) : (
        <p className="text-sm text-muted" data-testid="no-phone-hint">
          {t.rich("noPhoneHint", {
            link: (chunks) => (
              <Link
                href="/profile"
                className="font-semibold text-primary underline underline-offset-4"
              >
                {chunks}
              </Link>
            ),
          })}
        </p>
      )}
      <FormStatus error={write.error} success={write.success} />
      <SubmitButton
        pending={write.pending}
        label={t("submit")}
        pendingLabel={t("submitting")}
      />
    </form>
  );
}
