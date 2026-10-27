import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { requireActor } from "@/modules/identity/policy";
import { countJobApplications } from "@/modules/jobs/applications";
import { getJobForMember } from "@/modules/jobs/service";
import { dateTimeFormat, formatCount } from "@/modules/jobs/ui/format";
import { JobActions } from "@/modules/jobs/ui/job-actions";
import { JobDetails } from "@/modules/jobs/ui/job-details";
import { JobForm } from "@/modules/jobs/ui/job-form";
import { StatusBadge } from "@/modules/jobs/ui/status-badge";
import { listGovernorates } from "@/modules/profiles/governorates";
import { getDb } from "@/shared/db/client";
import { Link } from "@/shared/i18n/navigation";
import { isLocale } from "@/shared/i18n/routing";
import { PageShell, TextLink } from "@/shared/ui/page-shell";

type Props = { params: Promise<{ locale: string; jobId: string }> };

export const dynamicParams = true;

/**
 * One job for the members of its organization: status, the moderator's reason
 * when rejected, the edit form while editable, and the lifecycle buttons.
 * Anyone else, a missing and a malformed id all get 404.
 */
export default async function ManageJobPage({ params }: Props) {
  const { locale, jobId } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireActor();
  const db = getDb();
  const job = await getJobForMember(db, actor, jobId);
  if (!job) notFound();
  const applicationCount = (await countJobApplications(db, actor, job.id)) ?? 0;
  const governorates = job.permissions.edit ? await listGovernorates(db) : [];
  const t = await getTranslations("Jobs");
  const tr = await getTranslations("JobRejectReasons");
  const tc = await getTranslations("Common");
  const format = dateTimeFormat(await getLocale());
  const date = (value: string) => format.format(new Date(value));

  return (
    <PageShell title={job.title} homeLabel={tc("home")}>
      <section
        aria-labelledby="status-heading"
        className="flex flex-col gap-2 rounded-lg border border-muted bg-surface p-3"
      >
        <h2 id="status-heading" className="text-lg font-semibold">
          {t("statusLabel")}
        </h2>
        <p>
          <StatusBadge status={job.status} />
        </p>
        <p className="text-muted">{t(`statusHints.${job.status}`)}</p>
        {job.publishedAt ? (
          <p className="text-sm text-muted">
            {t("publishedOn", { date: date(job.publishedAt) })}
            {job.expiresAt
              ? ` · ${t("expiresOn", { date: date(job.expiresAt) })}`
              : ""}
          </p>
        ) : null}
        {job.status === "published" ? (
          <Link
            href={`/jobs/${job.id}`}
            className="inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-4"
            data-testid="job-public-link"
          >
            {t("viewPublic")}
          </Link>
        ) : null}
      </section>
      <Link
        href={`/manage/jobs/${job.id}/applications`}
        className="inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-4"
        data-testid="job-applications-link"
      >
        {t("applicationsLink", {
          count: formatCount(applicationCount, locale),
        })}
      </Link>
      {job.rejection ? (
        <section
          aria-labelledby="rejection-heading"
          role="status"
          className="flex flex-col gap-1 rounded-lg border border-red-700 bg-red-50 p-3 text-red-900"
          data-testid="job-rejection"
        >
          <h2 id="rejection-heading" className="text-lg font-semibold">
            {t("rejectionHeading")}
          </h2>
          <p>{tr(job.rejection.reasonCode)}</p>
          <p className="text-sm">
            {t("rejectionDate", { date: date(job.rejection.decidedAt) })}
          </p>
        </section>
      ) : null}
      {job.removal ? (
        <section
          aria-labelledby="removal-heading"
          role="status"
          className="flex flex-col gap-1 rounded-lg border border-red-700 bg-red-50 p-3 text-red-900"
          data-testid="job-removal"
        >
          <h2 id="removal-heading" className="text-lg font-semibold">
            {t("removalHeading")}
          </h2>
          <p>{tr(job.removal.reasonCode)}</p>
          <p className="text-sm">
            {t("removalDate", { date: date(job.removal.decidedAt) })}
          </p>
        </section>
      ) : null}
      <section
        aria-labelledby="actions-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="actions-heading" className="text-lg font-semibold">
          {t("actionsHeading")}
        </h2>
        <JobActions
          jobId={job.id}
          organizationId={job.organization.id}
          permissions={job.permissions}
        />
      </section>
      <section aria-labelledby="edit-heading" className="flex flex-col gap-3">
        <h2 id="edit-heading" className="text-lg font-semibold">
          {t("editHeading")}
        </h2>
        {job.permissions.edit ? (
          <JobForm job={job} governorates={governorates} />
        ) : (
          <>
            <p className="text-muted">{t("readOnlyNote")}</p>
            <JobDetails
              job={job}
              organization={job.organization}
              locale={locale}
            />
          </>
        )}
      </section>
      <TextLink href={`/organizations/${job.organization.id}/jobs`}>
        {t("backToList")}
      </TextLink>
    </PageShell>
  );
}
