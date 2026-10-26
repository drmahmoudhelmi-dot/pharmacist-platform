import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { requireActor } from "@/modules/identity/policy";
import { can } from "@/modules/jobs/policy";
import { JobForm } from "@/modules/jobs/ui/job-form";
import { getOrganizationForMember } from "@/modules/organizations/service";
import { listGovernorates } from "@/modules/profiles/governorates";
import { getDb } from "@/shared/db/client";
import { isLocale } from "@/shared/i18n/routing";
import { PageShell, TextLink } from "@/shared/ui/page-shell";

type Props = { params: Promise<{ locale: string; id: string }> };

export const dynamicParams = true;

/** The form for a new job draft. Members who may manage jobs only. */
export default async function NewJobPage({ params }: Props) {
  const { locale, id } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireActor();
  const db = getDb();
  const organization = await getOrganizationForMember(db, actor, id);
  if (!organization) notFound();
  if (!can(actor, "job.create", { actorRole: organization.myRole })) notFound();
  const governorates = await listGovernorates(db);
  const t = await getTranslations("Jobs");
  const tc = await getTranslations("Common");

  return (
    <PageShell title={t("newTitle")} homeLabel={tc("home")}>
      <p className="text-muted">
        <bdi className="font-semibold">{organization.name}</bdi> ·{" "}
        {t("newIntro")}
      </p>
      <JobForm organizationId={organization.id} governorates={governorates} />
      <TextLink href={`/organizations/${organization.id}/jobs`}>
        {t("backToList")}
      </TextLink>
    </PageShell>
  );
}
