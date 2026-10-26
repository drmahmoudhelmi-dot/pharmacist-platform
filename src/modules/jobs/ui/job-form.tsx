"use client";

import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { useRouter } from "@/shared/i18n/navigation";
import {
  ChoiceGroup,
  FormStatus,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
} from "@/shared/ui/form";
import { createJobAction, updateJobAction } from "../actions";
import {
  CAREER_STAGES,
  EMPLOYMENT_TYPES,
  JOB_CATEGORIES,
  LIMITS,
} from "../constants";
import type { JobContent } from "../service";
import { formDataToRaw, type JobField, parseJob } from "../validation";
import { useWrite } from "./use-write";

type Governorate = { id: number; nameAr: string; nameEn: string };

/** Creates a job draft in an organization, or edits the content of one. */
export function JobForm({
  organizationId,
  job,
  governorates,
}: {
  /** Needed to create. */
  organizationId?: string;
  /** Present when editing. */
  job?: JobContent & { id: string };
  governorates: readonly Governorate[];
}) {
  const t = useTranslations("Jobs");
  const tc = useTranslations("JobCategories");
  const tt = useTranslations("EmploymentTypes");
  const locale = useLocale();
  const router = useRouter();
  const write = useWrite<JobField, { jobId?: string }>();
  const [temporary, setTemporary] = useState(
    job?.employmentType === "temporary",
  );

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = parseJob(formDataToRaw(form));
    const id = job?.id;
    const result = await write.submit(
      parsed.ok ? null : parsed.fieldErrors,
      () =>
        id
          ? updateJobAction(id, form)
          : createJobAction(organizationId ?? "", form),
      id ? t("saved") : t("created"),
    );
    if (!id && result?.ok && result.jobId)
      router.push(`/manage/jobs/${result.jobId}`);
  }

  return (
    <form
      noValidate
      onSubmit={onSubmit}
      className="flex flex-col gap-4"
      data-testid="job-form"
    >
      <TextField
        name="title"
        label={t("titleLabel")}
        hint={t("titleHint")}
        dir="auto"
        maxLength={LIMITS.title.max}
        defaultValue={job?.title}
        error={write.fieldError("title")}
      />
      <SelectField
        name="category"
        label={t("categoryLabel")}
        placeholder={t("choose")}
        options={JOB_CATEGORIES.map((value) => ({
          value,
          label: tc(value),
        }))}
        defaultValue={job?.category}
        error={write.fieldError("category")}
      />
      <ChoiceGroup
        name="employmentType"
        type="radio"
        legend={t("employmentTypeLegend")}
        options={EMPLOYMENT_TYPES.map((value) => ({
          value,
          label: tt(value),
        }))}
        defaultValues={[job?.employmentType ?? "full_time"]}
        onChange={(value) => setTemporary(value === "temporary")}
        error={write.fieldError("employmentType")}
      />
      {temporary ? (
        <>
          <p className="text-sm text-muted">{t("temporaryHint")}</p>
          <TextField
            name="startDate"
            type="date"
            label={t("startDateLabel")}
            defaultValue={job?.startDate ?? undefined}
            error={write.fieldError("startDate")}
          />
          <TextField
            name="endDate"
            type="date"
            label={t("endDateLabel")}
            defaultValue={job?.endDate ?? undefined}
            error={write.fieldError("endDate")}
          />
        </>
      ) : null}
      <SelectField
        name="governorateId"
        label={t("governorateLabel")}
        placeholder={t("choose")}
        options={governorates.map((g) => ({
          value: String(g.id),
          label: locale === "ar" ? g.nameAr : g.nameEn,
        }))}
        defaultValue={job ? String(job.governorateId) : undefined}
        error={write.fieldError("governorateId")}
      />
      <TextField
        name="area"
        label={t("areaLabel")}
        hint={t("areaHint")}
        dir="auto"
        required={false}
        maxLength={LIMITS.area.max}
        defaultValue={job?.area ?? undefined}
        error={write.fieldError("area")}
      />
      <TextAreaField
        name="description"
        label={t("descriptionLabel")}
        hint={t("descriptionHint")}
        required
        rows={8}
        maxLength={LIMITS.description.max}
        defaultValue={job?.description}
        error={write.fieldError("description")}
      />
      <TextField
        name="minYearsExperience"
        label={t("minYearsLabel")}
        hint={t("minYearsHint")}
        inputMode="numeric"
        required={false}
        maxLength={3}
        defaultValue={job ? String(job.minYearsExperience) : undefined}
        error={write.fieldError("minYearsExperience")}
      />
      <ChoiceGroup
        name="careerStages"
        type="checkbox"
        legend={t("careerStagesLegend")}
        options={CAREER_STAGES.map((value) => ({
          value,
          label: t(`careerStages.${value}`),
        }))}
        defaultValues={job?.careerStages ?? []}
        error={write.fieldError("careerStages")}
      />
      <TextField
        name="salaryMin"
        label={t("salaryMinLabel")}
        hint={t("salaryHint")}
        inputMode="numeric"
        required={false}
        maxLength={9}
        defaultValue={job?.salaryMinPounds?.toString()}
        error={write.fieldError("salaryMin")}
      />
      <TextField
        name="salaryMax"
        label={t("salaryMaxLabel")}
        inputMode="numeric"
        required={false}
        maxLength={9}
        defaultValue={job?.salaryMaxPounds?.toString()}
        error={write.fieldError("salaryMax")}
      />
      <FormStatus error={write.error} success={write.success} />
      <SubmitButton
        pending={write.pending}
        label={job ? t("save") : t("create")}
        pendingLabel={t("saving")}
      />
    </form>
  );
}
