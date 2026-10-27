import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { getActor } from "@/modules/identity/policy";
import { getApplyState } from "@/modules/jobs/applications";
import { getPublicJob, getReportState } from "@/modules/jobs/service";
import { dateTimeFormat } from "@/modules/jobs/ui/format";
import { ApplySection } from "@/modules/jobs/ui/apply-section";
import { JobDetails } from "@/modules/jobs/ui/job-details";
import { ReportSection } from "@/modules/jobs/ui/report-section";
import { getDb } from "@/shared/db/client";
import { isLocale } from "@/shared/i18n/routing";
import { PageShell, TextLink } from "@/shared/ui/page-shell";

type Props = { params: Promise<{ locale: string; id: string }> };

export const dynamicParams = true;

/** A live job for anyone. Any other status, a missing and a malformed id: 404. */
export default async function JobPage({ params }: Props) {
  const { locale: routeLocale, id } = await params;
  const locale = isLocale(routeLocale) ? routeLocale : "ar";
  setRequestLocale(locale);
  const job = await getPublicJob(getDb(), id);
  if (!job) notFound();
  const t = await getTranslations("Jobs");
  const tc = await getTranslations("Common");
  const format = dateTimeFormat(await getLocale());
  const actor = await getActor();
  const applyState = await getApplyState(getDb(), actor, job.id);
  const reportState = await getReportState(getDb(), actor, job.id);

  return (
    <PageShell title={job.title} homeLabel={tc("home")}>
      <JobDetails
        job={job}
        organization={job.organization}
        locale={locale}
        posterVerified={job.posterVerified}
        publishedLabel={format.format(new Date(job.publishedAt))}
      />
      <ApplySection jobId={job.id} state={applyState} />
      <ReportSection jobId={job.id} state={reportState} />
      <TextLink href="/jobs">{t("backToBoard")}</TextLink>
    </PageShell>
  );
}
