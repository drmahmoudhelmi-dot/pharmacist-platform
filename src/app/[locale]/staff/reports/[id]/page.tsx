import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { requireStaff } from "@/modules/identity/policy";
import { getJobForModeration } from "@/modules/jobs/service";
import { JobDetails } from "@/modules/jobs/ui/job-details";
import {
  DismissReportsButton,
  RemoveJobForm,
} from "@/modules/jobs/ui/moderation-controls";
import { StatusBadge } from "@/modules/jobs/ui/status-badge";
import { getDb } from "@/shared/db/client";
import { isLocale } from "@/shared/i18n/routing";
import { PageShell, TextLink } from "@/shared/ui/page-shell";

type Props = { params: Promise<{ locale: string; id: string }> };

export const dynamicParams = true;

/**
 * One reported job for a moderator, with its reports. A job of the
 * moderator's own organization, a missing and a malformed id all answer 404.
 */
export default async function ReportedJobPage({ params }: Props) {
  const { locale, id } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireStaff("moderator");
  const job = await getJobForModeration(getDb(), actor, id);
  if (!job) notFound();
  const t = await getTranslations("StaffReports");
  const tr = await getTranslations("ReportReasons");
  const tc = await getTranslations("Common");
  const format = new Intl.DateTimeFormat(
    (await getLocale()) === "ar" ? "ar-EG" : "en-GB",
    { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" },
  );

  return (
    <PageShell title={t("detailTitle")} homeLabel={tc("home")}>
      <h2 className="text-xl font-bold" data-testid="reported-job-title">
        <bdi>{job.title}</bdi>
      </h2>
      <p>
        <StatusBadge status={job.status} />
      </p>
      <JobDetails
        job={job}
        organization={job.organization}
        locale={locale}
        posterVerified={job.posterVerified}
      />
      <section
        aria-labelledby="reports-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="reports-heading" className="text-lg font-semibold">
          {t("reportsHeading")}
        </h2>
        {job.reports.length === 0 ? (
          <p className="text-muted">{t("noReports")}</p>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="reports">
            {job.reports.map((r) => (
              <li
                key={r.id}
                className="flex flex-col gap-1 rounded-lg border border-muted bg-surface p-3"
                data-testid="report"
                data-status={r.status}
              >
                <span className="font-semibold">{tr(r.reasonCode)}</span>
                {r.details ? (
                  <bdi className="break-words text-sm">{r.details}</bdi>
                ) : null}
                <span className="text-sm text-muted">
                  {r.reporterEmail ? (
                    <bdi dir="ltr" className="break-all">
                      {r.reporterEmail}
                    </bdi>
                  ) : (
                    t("reporterGone")
                  )}
                  {" · "}
                  {format.format(new Date(r.createdAt))}
                  {" · "}
                  {t(`reportStatuses.${r.status}`)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {job.canDismiss ? (
        <section
          aria-labelledby="dismiss-heading"
          className="flex flex-col gap-3"
        >
          <h2 id="dismiss-heading" className="text-lg font-semibold">
            {t("dismissHeading")}
          </h2>
          <p className="text-sm text-muted">{t("dismissIntro")}</p>
          <DismissReportsButton jobId={job.id} />
        </section>
      ) : null}
      {job.canRemove ? (
        <section
          aria-labelledby="remove-heading"
          className="flex flex-col gap-3"
        >
          <h2 id="remove-heading" className="text-lg font-semibold">
            {t("removeHeading")}
          </h2>
          <p className="text-sm text-muted">{t("removeIntro")}</p>
          <RemoveJobForm jobId={job.id} />
        </section>
      ) : null}
      <TextLink href="/staff/reports">{t("queueLink")}</TextLink>
    </PageShell>
  );
}
