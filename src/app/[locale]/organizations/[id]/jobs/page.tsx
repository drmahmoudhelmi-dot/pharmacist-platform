import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { requireActor } from "@/modules/identity/policy";
import { listOrganizationJobs } from "@/modules/jobs/service";
import { dateTimeFormat } from "@/modules/jobs/ui/format";
import { StatusBadge } from "@/modules/jobs/ui/status-badge";
import { getOrganizationForMember } from "@/modules/organizations/service";
import { getDb } from "@/shared/db/client";
import { Link } from "@/shared/i18n/navigation";
import { isLocale } from "@/shared/i18n/routing";
import { PageShell, TextLink } from "@/shared/ui/page-shell";

type Props = { params: Promise<{ locale: string; id: string }> };

export const dynamicParams = true;

/** An organization's jobs, for its members. Others get the same 404. */
export default async function OrganizationJobsPage({ params }: Props) {
  const { locale, id } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireActor();
  const db = getDb();
  const organization = await getOrganizationForMember(db, actor, id);
  if (!organization) notFound();
  const jobs = await listOrganizationJobs(db, actor, organization.id);
  const t = await getTranslations("Jobs");
  const tc = await getTranslations("JobCategories");
  const tt = await getTranslations("EmploymentTypes");
  const tcm = await getTranslations("Common");
  const format = dateTimeFormat(await getLocale());

  return (
    <PageShell title={t("listTitle")} homeLabel={tcm("home")}>
      <p className="text-muted">
        <bdi className="font-semibold">{organization.name}</bdi> ·{" "}
        {t("listIntro")}
      </p>
      <Link
        href={`/organizations/${organization.id}/jobs/new`}
        className="inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-5 font-semibold text-white hover:bg-primary-strong"
      >
        {t("newJob")}
      </Link>
      {jobs.length === 0 ? (
        <p
          className="rounded-lg border border-muted bg-surface p-3"
          data-testid="jobs-empty"
        >
          {t("listEmpty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="job-list">
          {jobs.map((job) => (
            <li key={job.id}>
              <Link
                href={`/manage/jobs/${job.id}`}
                className="flex min-h-11 flex-col gap-1 rounded-lg border border-muted bg-surface p-3 hover:border-primary"
                data-testid="job-item"
              >
                <bdi className="font-semibold text-primary">{job.title}</bdi>
                <span className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={job.status} />
                  <span className="text-sm text-muted">
                    {tc(job.category)} · {tt(job.employmentType)}
                  </span>
                </span>
                <span className="text-sm text-muted">
                  {t("updatedAt", {
                    date: format.format(new Date(job.updatedAt)),
                  })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <TextLink href={`/organizations/${organization.id}`}>
        {t("backToOrganization")}
      </TextLink>
    </PageShell>
  );
}
