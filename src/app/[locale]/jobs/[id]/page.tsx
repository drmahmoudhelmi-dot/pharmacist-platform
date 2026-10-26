import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { getPublicJob } from "@/modules/jobs/service";
import { dateTimeFormat } from "@/modules/jobs/ui/format";
import { JobDetails } from "@/modules/jobs/ui/job-details";
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

  return (
    <PageShell title={job.title} homeLabel={tc("home")}>
      <JobDetails
        job={job}
        organization={job.organization}
        locale={locale}
        posterVerified={job.posterVerified}
        publishedLabel={format.format(new Date(job.publishedAt))}
      />
      <TextLink href="/jobs">{t("backToBoard")}</TextLink>
    </PageShell>
  );
}
