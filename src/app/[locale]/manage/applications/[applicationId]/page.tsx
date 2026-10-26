import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { requireActor } from "@/modules/identity/policy";
import { getApplicationForEmployer } from "@/modules/jobs/applications";
import { ApplicantSnapshot } from "@/modules/jobs/ui/applicant-snapshot";
import { ApplicationStatusBadge } from "@/modules/jobs/ui/application-status-badge";
import { dateTimeFormat } from "@/modules/jobs/ui/format";
import { MoveButtons } from "@/modules/jobs/ui/move-buttons";
import { getDb } from "@/shared/db/client";
import { isLocale } from "@/shared/i18n/routing";
import { PageShell, TextLink } from "@/shared/ui/page-shell";

type Props = { params: Promise<{ locale: string; applicationId: string }> };

export const dynamicParams = true;

/**
 * One application for the members of the job's organization: what the
 * applicant shared and the moves allowed. Anyone else, a missing and a
 * malformed id all get 404.
 */
export default async function ApplicationPage({ params }: Props) {
  const { locale, applicationId } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireActor();
  const application = await getApplicationForEmployer(
    getDb(),
    actor,
    applicationId,
  );
  if (!application) notFound();
  const t = await getTranslations("Applications");
  const tc = await getTranslations("Common");
  const format = dateTimeFormat(await getLocale());

  return (
    <PageShell title={t("applicationTitle")} homeLabel={tc("home")}>
      <section
        aria-labelledby="summary-heading"
        className="flex flex-col gap-2 rounded-lg border border-muted bg-surface p-3"
      >
        <h2 id="summary-heading" className="text-lg font-semibold">
          <bdi>{application.jobTitle}</bdi>
        </h2>
        <p className="flex flex-wrap items-center gap-2">
          <ApplicationStatusBadge status={application.status} />
          <span className="text-sm text-muted">
            {t("submittedOn", {
              date: format.format(new Date(application.submittedAt)),
            })}
          </span>
        </p>
      </section>
      <section aria-labelledby="moves-heading" className="flex flex-col gap-3">
        <h2 id="moves-heading" className="text-lg font-semibold">
          {t("movesHeading")}
        </h2>
        <MoveButtons applicationId={application.id} moves={application.moves} />
      </section>
      {application.shared ? (
        <>
          <p className="text-sm text-muted">{t("snapshotNote")}</p>
          <ApplicantSnapshot
            profile={application.shared.profile}
            phoneE164={application.shared.phoneE164}
            coverNote={application.shared.coverNote}
            verified={application.applicantVerified}
          />
        </>
      ) : (
        <section
          className="flex flex-col gap-1 rounded-lg border border-muted bg-surface p-3"
          data-testid="application-withdrawn"
        >
          <p className="font-semibold">
            <bdi>{application.displayName}</bdi>
          </p>
          <p className="text-muted">{t("withdrawnRedacted")}</p>
        </section>
      )}
      <TextLink href={`/manage/jobs/${application.jobId}/applications`}>
        {t("backToApplications")}
      </TextLink>
    </PageShell>
  );
}
