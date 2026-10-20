"use client";

import { useTranslations } from "next-intl";
import type { FormEvent } from "react";
import { FormStatus, SubmitButton, TextField } from "@/shared/ui/form";
import { saveProfessionalDetailsAction } from "../actions";
import { LIMITS } from "../constants";
import type { OwnProfessionalDetails } from "../service";
import {
  formDataToRaw,
  parseProfessionalDetails,
  type ProfessionalDetailsField,
} from "../validation";
import { useWrite } from "./use-write";

/** Shows a stored +20 number the way Egyptians type it: 01XXXXXXXXX. */
function nationalFormat(e164: string | null): string | undefined {
  return e164?.startsWith("+20") ? `0${e164.slice(3)}` : undefined;
}

export function ProfessionalDetailsForm({
  details,
}: {
  details: OwnProfessionalDetails | null;
}) {
  const t = useTranslations("Profile");
  const write = useWrite<ProfessionalDetailsField>();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = parseProfessionalDetails(formDataToRaw(form));
    await write.submit(
      parsed.ok ? null : parsed.fieldErrors,
      () => saveProfessionalDetailsAction(form),
      t("detailsSaved"),
    );
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      <TextField
        name="phone"
        type="tel"
        label={t("phoneLabel")}
        hint={t("phoneHint")}
        autoComplete="tel-national"
        inputMode="tel"
        required={false}
        maxLength={20}
        defaultValue={nationalFormat(details?.phoneE164 ?? null)}
        error={write.fieldError("phone")}
      />
      <TextField
        name="university"
        label={t("universityLabel")}
        dir="auto"
        required={false}
        maxLength={LIMITS.university.max}
        defaultValue={details?.university ?? undefined}
        error={write.fieldError("university")}
      />
      <TextField
        name="graduationYear"
        label={t("graduationYearLabel")}
        hint={t("graduationYearHint")}
        inputMode="numeric"
        required={false}
        maxLength={4}
        defaultValue={
          details?.graduationYear ? String(details.graduationYear) : undefined
        }
        error={write.fieldError("graduationYear")}
      />
      <FormStatus error={write.error} success={write.success} />
      <SubmitButton
        pending={write.pending}
        label={t("saveDetails")}
        pendingLabel={t("saving")}
      />
    </form>
  );
}
