import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { listMyApplications } from "@/modules/jobs/applications";
import { requireActor } from "@/modules/identity/policy";
import { ApplicationStatusBadge } from "@/modules/jobs/ui/application-status-badge";
import { dateTimeFormat } from "@/modules/jobs/ui/format";
import { WithdrawButton } from "@/modules/jobs/ui/withdraw-button";
import { getDb } from "@/shared/db/client";
import { Link } from "@/shared/i18n/navigation";
import { isLocale } from "@/shared/i18n/routing";
import { PageShell, TextLink } from "@/shared/ui/page-shell";

type Props = { params: Promise<{ locale: string }> };

/** The signed-in user's own applications, newest first. */
export default async function ApplicationsPage({ params }: Props) {
  const { locale } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireActor();
  const applications = await listMyApplications(getDb(), actor);
  const t = await getTranslations("Applications");
  const tc = await getTranslations("Common");
  const format = dateTimeFormat(await getLocale());

  return (
    <PageShell title={t("title")} homeLabel={tc("home")}>
      <p className="text-muted">{t("intro")}</p>
      {applications.length === 0 ? (
        <div
          className="flex flex-col gap-2 rounded-lg border border-muted bg-surface p-3"
          data-testid="applications-empty"
        >
          <p>{t("empty")}</p>
          <TextLink href="/jobs">{t("browseJobs")}</TextLink>
        </div>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="application-list">
          {applications.map((a) => (
            <li
              key={a.id}
              className="flex flex-col gap-2 rounded-lg border border-muted bg-surface p-3"
              data-testid="application-item"
            >
              <h2 className="text-lg font-semibold">
                <bdi>{a.jobTitle}</bdi>
              </h2>
              <p>
                <bdi>{a.organizationName}</bdi>
              </p>
              <p className="flex flex-wrap items-center gap-2">
                <ApplicationStatusBadge status={a.status} />
                <span className="text-sm text-muted">
                  {t("submittedOn", {
                    date: format.format(new Date(a.submittedAt)),
                  })}
                </span>
              </p>
              {a.jobLive ? (
                <Link
                  href={`/jobs/${a.jobId}`}
                  className="inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-4"
                >
                  {t("viewJob")}
                </Link>
              ) : (
                <p className="text-sm text-muted">{t("jobNoLongerLive")}</p>
              )}
              {a.canWithdraw ? <WithdrawButton applicationId={a.id} /> : null}
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}
