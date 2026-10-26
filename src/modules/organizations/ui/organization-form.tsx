"use client";

import { useLocale, useTranslations } from "next-intl";
import type { FormEvent } from "react";
import { useRouter } from "@/shared/i18n/navigation";
import {
  ChoiceGroup,
  FormStatus,
  SelectField,
  SubmitButton,
  TextField,
} from "@/shared/ui/form";
import { createOrganizationAction, updateOrganizationAction } from "../actions";
import { LIMITS, ORGANIZATION_KINDS } from "../constants";
import type { OrganizationView } from "../service";
import {
  formDataToRaw,
  type OrganizationField,
  parseOrganization,
} from "../validation";
import { useWrite } from "./use-write";

type Governorate = { id: number; nameAr: string; nameEn: string };

/** Creates an organization (no `organization`) or edits one. */
export function OrganizationForm({
  organization,
  governorates,
}: {
  organization?: OrganizationView;
  governorates: readonly Governorate[];
}) {
  const t = useTranslations("Organizations");
  const tk = useTranslations("OrganizationKinds");
  const locale = useLocale();
  const router = useRouter();
  const write = useWrite<OrganizationField, { organizationId?: string }>();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = parseOrganization(formDataToRaw(form));
    const id = organization?.id;
    const result = await write.submit(
      parsed.ok ? null : parsed.fieldErrors,
      () =>
        id
          ? updateOrganizationAction(id, form)
          : createOrganizationAction(form),
      id ? t("saved") : t("created"),
    );
    if (!id && result?.ok && result.organizationId)
      router.push(`/organizations/${result.organizationId}`);
  }

  return (
    <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
      <ChoiceGroup
        name="kind"
        type="radio"
        legend={t("kindLegend")}
        options={ORGANIZATION_KINDS.map((value) => ({
          value,
          label: tk(value),
          hint: t(`kindHints.${value}`),
        }))}
        defaultValues={[organization?.kind ?? "pharmacy"]}
        error={write.fieldError("kind")}
      />
      <TextField
        name="name"
        label={t("nameLabel")}
        hint={t("nameHint")}
        dir="auto"
        autoComplete="organization"
        maxLength={LIMITS.name.max}
        defaultValue={organization?.name}
        error={write.fieldError("name")}
      />
      <SelectField
        name="governorateId"
        label={t("governorateLabel")}
        placeholder={t("choose")}
        options={governorates.map((g) => ({
          value: String(g.id),
          label: locale === "ar" ? g.nameAr : g.nameEn,
        }))}
        defaultValue={
          organization ? String(organization.governorateId) : undefined
        }
        error={write.fieldError("governorateId")}
      />
      <TextField
        name="addressLine"
        label={t("addressLabel")}
        hint={t("addressHint")}
        dir="auto"
        autoComplete="street-address"
        required={false}
        maxLength={LIMITS.addressLine.max}
        defaultValue={organization?.addressLine ?? undefined}
        error={write.fieldError("addressLine")}
      />
      <FormStatus error={write.error} success={write.success} />
      <SubmitButton
        pending={write.pending}
        label={organization ? t("save") : t("create")}
        pendingLabel={t("saving")}
      />
    </form>
  );
}
