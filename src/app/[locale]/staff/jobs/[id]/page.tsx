import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { requireStaff } from "@/modules/identity/policy";
import { getJobForReview } from "@/modules/jobs/service";
import { JobDecisionForm } from "@/modules/jobs/ui/decision-form";
import { JobDetails } from "@/modules/jobs/ui/job-details";
import { getDb } from "@/shared/db/client";
import { isLocale } from "@/shared/i18n/routing";
import { PageShell, TextLink } from "@/shared/ui/page-shell";

type Props = { params: Promise<{ locale: string; id: string }> };

export const dynamicParams = true;

/**
 * One pending job for a moderator. A job that is not pending, one of the
 * moderator's own organizations, a missing and a malformed id all answer 404.
 */
export default async function ReviewJobPage({ params }: Props) {
  const { locale, id } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireStaff("moderator");
  const job = await getJobForReview(getDb(), actor, id);
  if (!job) notFound();
  const t = await getTranslations("StaffJobs");
  const tc = await getTranslations("Common");

  return (
    <PageShell title={t("detailTitle")} homeLabel={tc("home")}>
      <h2 className="text-xl font-bold" data-testid="review-job-title">
        <bdi>{job.title}</bdi>
      </h2>
      <JobDetails
        job={job}
        organization={job.organization}
        locale={locale}
        posterVerified={job.posterVerified}
      />
      <section
        aria-labelledby="decision-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="decision-heading" className="text-lg font-semibold">
          {t("decisionHeading")}
        </h2>
        <JobDecisionForm jobId={job.id} />
      </section>
      <TextLink href="/staff/jobs">{t("queueLink")}</TextLink>
    </PageShell>
  );
}
