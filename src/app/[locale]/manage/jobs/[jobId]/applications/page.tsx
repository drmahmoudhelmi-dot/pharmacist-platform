import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { requireActor } from "@/modules/identity/policy";
import { listJobApplications } from "@/modules/jobs/applications";
import { getJobForMember } from "@/modules/jobs/service";
import { ApplicationStatusBadge } from "@/modules/jobs/ui/application-status-badge";
import { dateTimeFormat, formatCount } from "@/modules/jobs/ui/format";
import { VerifiedBadge } from "@/modules/profiles/ui/profile-view";
import { getDb } from "@/shared/db/client";
import { Link } from "@/shared/i18n/navigation";
import { isLocale } from "@/shared/i18n/routing";
import { PageShell, TextLink } from "@/shared/ui/page-shell";

type Props = {
  params: Promise<{ locale: string; jobId: string }>;
  searchParams: Promise<{ cursor?: string | string[] }>;
};

export const dynamicParams = true;

/** A job's applications for the members of its organization; others: 404. */
export default async function JobApplicationsPage({
  params,
  searchParams,
}: Props) {
  const { locale, jobId } = await params;
  const { cursor } = await searchParams;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireActor();
  const db = getDb();
  const job = await getJobForMember(db, actor, jobId);
  if (!job) notFound();
  const page = await listJobApplications(
    db,
    actor,
    job.id,
    typeof cursor === "string" ? cursor : undefined,
  );
  const applications = page.items;
  const t = await getTranslations("Applications");
  const tp = await getTranslations("Profile");
  const tv = await getTranslations("ProfileView");
  const tc = await getTranslations("Common");
  const format = dateTimeFormat(await getLocale());

  return (
    <PageShell title={t("employerTitle")} homeLabel={tc("home")}>
      <p className="text-muted">
        <bdi className="font-semibold">{job.title}</bdi> · {t("employerIntro")}
      </p>
      {applications.length === 0 ? (
        <p
          className="rounded-lg border border-muted bg-surface p-3"
          data-testid="applications-empty"
        >
          {t("employerEmpty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="application-list">
          {applications.map((a) => (
            <li key={a.id}>
              <Link
                href={`/manage/applications/${a.id}`}
                className="flex min-h-11 flex-col gap-1 rounded-lg border border-muted bg-surface p-3 hover:border-primary"
                data-testid="application-item"
              >
                <bdi className="font-semibold text-primary">
                  {a.displayName}
                </bdi>
                <span className="text-sm text-muted">
                  {tp(`careerStages.${a.careerStage}`)}
                  {a.yearsExperience !== null
                    ? ` · ${tv("yearsExperience", {
                        count: a.yearsExperience,
                        formatted: formatCount(a.yearsExperience, locale),
                      })}`
                    : null}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <ApplicationStatusBadge status={a.status} />
                  {a.applicantVerified ? (
                    <VerifiedBadge label={tv("verifiedBadge")} />
                  ) : null}
                </span>
                <span className="text-sm text-muted">
                  {t("submittedOn", {
                    date: format.format(new Date(a.submittedAt)),
                  })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {page.nextCursor ? (
        <TextLink
          href={`/manage/jobs/${job.id}/applications?cursor=${page.nextCursor}`}
        >
          {t("nextPage")}
        </TextLink>
      ) : null}
      <TextLink href={`/manage/jobs/${job.id}`}>{t("backToJob")}</TextLink>
    </PageShell>
  );
}
