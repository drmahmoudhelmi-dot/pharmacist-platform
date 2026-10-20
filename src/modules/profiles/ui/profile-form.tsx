"use client";

import { useLocale, useTranslations } from "next-intl";
import type { FormEvent } from "react";
import {
  CheckboxField,
  ChoiceGroup,
  FormStatus,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
} from "@/shared/ui/form";
import { saveProfileAction } from "../actions";
import { CAREER_STAGES, LIMITS, SPECIALTIES, VISIBILITIES } from "../constants";
import type { Governorate, OwnProfile } from "../service";
import { formDataToRaw, parseProfile, type ProfileField } from "../validation";
import { useWrite } from "./use-write";

export function ProfileForm({
  profile,
  governorates,
}: {
  profile: OwnProfile | null;
  governorates: Governorate[];
}) {
  const t = useTranslations("Profile");
  const locale = useLocale();
  const write = useWrite<ProfileField>();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = parseProfile(formDataToRaw(form, ["specialties"]));
    await write.submit(
      parsed.ok ? null : parsed.fieldErrors,
      () => saveProfileAction(form),
      t("profileSaved"),
    );
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      <TextField
        name="displayName"
        label={t("displayNameLabel")}
        hint={t("displayNameHint")}
        autoComplete="name"
        dir="auto"
        maxLength={LIMITS.displayName.max}
        defaultValue={profile?.displayName}
        error={write.fieldError("displayName")}
      />
      <TextField
        name="headline"
        label={t("headlineLabel")}
        hint={t("headlineHint")}
        dir="auto"
        required={false}
        maxLength={LIMITS.headline.max}
        defaultValue={profile?.headline ?? undefined}
        error={write.fieldError("headline")}
      />
      <TextAreaField
        name="bio"
        label={t("bioLabel")}
        hint={t("bioHint")}
        maxLength={LIMITS.bio.max}
        defaultValue={profile?.bio ?? undefined}
        error={write.fieldError("bio")}
      />
      <SelectField
        name="careerStage"
        label={t("careerStageLabel")}
        placeholder={t("choose")}
        options={CAREER_STAGES.map((value) => ({
          value,
          label: t(`careerStages.${value}`),
        }))}
        defaultValue={profile?.careerStage}
        error={write.fieldError("careerStage")}
      />
      <TextField
        name="yearsExperience"
        label={t("yearsLabel")}
        hint={t("yearsHint")}
        inputMode="numeric"
        maxLength={3}
        defaultValue={String(profile?.yearsExperience ?? 0)}
        error={write.fieldError("yearsExperience")}
      />
      <SelectField
        name="governorateId"
        label={t("governorateLabel")}
        placeholder={t("governorateNone")}
        required={false}
        options={governorates.map((g) => ({
          value: String(g.id),
          label: locale === "ar" ? g.nameAr : g.nameEn,
        }))}
        defaultValue={
          profile?.governorateId ? String(profile.governorateId) : ""
        }
        error={write.fieldError("governorateId")}
      />
      <ChoiceGroup
        name="specialties"
        type="checkbox"
        legend={t("specialtiesLegend")}
        options={SPECIALTIES.map((value) => ({
          value,
          label: t(`specialties.${value}`),
        }))}
        defaultValues={profile?.specialties ?? []}
        error={write.fieldError("specialties")}
      />
      <CheckboxField
        name="openToWork"
        label={t("openToWorkLabel")}
        defaultChecked={profile?.openToWork ?? false}
      />
      <ChoiceGroup
        name="visibility"
        type="radio"
        legend={t("visibilityLegend")}
        options={VISIBILITIES.map((value) => ({
          value,
          label: t(`visibility.${value}`),
          hint: t(`visibilityHints.${value}`),
        }))}
        defaultValues={[profile?.visibility ?? "members"]}
        error={write.fieldError("visibility")}
      />
      <FormStatus error={write.error} success={write.success} />
      <SubmitButton
        pending={write.pending}
        label={t("saveProfile")}
        pendingLabel={t("saving")}
      />
    </form>
  );
}
