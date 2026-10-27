import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { requireStaff } from "@/modules/identity/policy";
import { listReportQueue } from "@/modules/jobs/service";
import { formatCount } from "@/modules/jobs/ui/format";
import { getDb } from "@/shared/db/client";
import { Link } from "@/shared/i18n/navigation";
import { isLocale } from "@/shared/i18n/routing";
import { PageShell, TextLink } from "@/shared/ui/page-shell";

type Props = { params: Promise<{ locale: string }> };

// Reported jobs (ADR-009): jobs with open reports, oldest report first.
// Needs the moderator role and a session that passed TOTP.
export default async function ReportQueuePage({ params }: Props) {
  const { locale } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireStaff("moderator");
  const queue = await listReportQueue(getDb(), actor);
  const t = await getTranslations("StaffReports");
  const tr = await getTranslations("ReportReasons");
  const ts = await getTranslations("JobStatuses");
  const tc = await getTranslations("Common");
  const dateLocale = (await getLocale()) === "ar" ? "ar-EG" : "en-GB";
  const format = new Intl.DateTimeFormat(dateLocale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Cairo",
  });
  const list = new Intl.ListFormat(dateLocale, { type: "conjunction" });

  return (
    <PageShell title={t("queueTitle")} homeLabel={tc("home")}>
      <p className="text-muted">{t("queueIntro")}</p>
      {queue.length === 0 ? (
        <p
          className="rounded-lg border border-muted bg-surface p-3"
          data-testid="reports-empty"
        >
          {t("queueEmpty")}
        </p>
      ) : (
        <ol className="flex flex-col gap-3" data-testid="report-queue">
          {queue.map((item) => (
            <li key={item.jobId}>
              <Link
                href={`/staff/reports/${item.jobId}`}
                className="flex min-h-11 flex-col gap-1 rounded-lg border border-muted bg-surface p-3 hover:border-primary"
                data-testid="report-queue-item"
              >
                <bdi className="font-semibold">{item.title}</bdi>
                <bdi>{item.organizationName}</bdi>
                <span className="text-sm">
                  {t("openReports", {
                    count: formatCount(item.openReports, locale),
                  })}
                  {": "}
                  {list.format(item.reasons.map((r) => tr(r)))}
                </span>
                <span className="text-sm text-muted">
                  {ts(item.status)}
                  {" · "}
                  {t("oldestReport", {
                    date: format.format(new Date(item.oldestReportAt)),
                  })}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
      <TextLink href="/staff">{t("staffLink")}</TextLink>
    </PageShell>
  );
}
