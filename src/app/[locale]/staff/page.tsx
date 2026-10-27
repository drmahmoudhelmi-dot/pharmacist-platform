import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { can, requireStaff } from "@/modules/identity/policy";
import {
  countJobsWithOpenReports,
  countPendingJobReviews,
} from "@/modules/jobs/service";
import { countPendingVerifications } from "@/modules/verification/service";
import { getDb } from "@/shared/db/client";
import { formatCount } from "@/shared/i18n/format";
import { Link } from "@/shared/i18n/navigation";
import { isLocale } from "@/shared/i18n/routing";
import { PageShell } from "@/shared/ui/page-shell";

type Props = { params: Promise<{ locale: string }> };

type Duty = {
  key: string;
  href: string;
  title: string;
  description: string;
  /** Live number and what it counts; absent for duties without a queue. */
  count?: { value: number; label: string };
};

// The guard is the real content: a staff role, TOTP enabled and a session
// that passed it. Each card shows only the duties the actor holds.
export default async function StaffPage({ params }: Props) {
  const { locale } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireStaff();
  const t = await getTranslations("Staff");
  const tr = await getTranslations("Roles");
  const tc = await getTranslations("Common");
  const currentLocale = await getLocale();
  const db = getDb();

  const [pendingVerifications, pendingJobs, reportedJobs] = await Promise.all([
    countPendingVerifications(db, actor),
    countPendingJobReviews(db, actor),
    countJobsWithOpenReports(db, actor),
  ]);

  const duties: Duty[] = [];
  if (can(actor, "verification.review")) {
    duties.push({
      key: "verification",
      href: "/staff/verification",
      title: t("verificationLink"),
      description: t("verificationDescription"),
      count:
        pendingVerifications === null
          ? undefined
          : {
              value: pendingVerifications,
              label: t("verificationCount"),
            },
    });
  }
  if (can(actor, "moderation.access")) {
    duties.push(
      {
        key: "jobs",
        href: "/staff/jobs",
        title: t("jobsLink"),
        description: t("jobsDescription"),
        count:
          pendingJobs === null
            ? undefined
            : { value: pendingJobs, label: t("jobsCount") },
      },
      {
        key: "reports",
        href: "/staff/reports",
        title: t("reportsLink"),
        description: t("reportsDescription"),
        count:
          reportedJobs === null
            ? undefined
            : { value: reportedJobs, label: t("reportsCount") },
      },
    );
  }
  if (can(actor, "account.suspend")) {
    duties.push({
      key: "accounts",
      href: "/staff/accounts",
      title: t("accountsLink"),
      description: t("accountsDescription"),
    });
  }
  if (can(actor, "roles.manage")) {
    duties.push({
      key: "roles",
      href: "/staff/roles",
      title: t("rolesAdminLink"),
      description: t("rolesDescription"),
    });
  }
  if (can(actor, "audit.read")) {
    duties.push({
      key: "audit",
      href: "/staff/audit",
      title: t("auditLink"),
      description: t("auditDescription"),
    });
  }

  return (
    <PageShell title={t("title")} homeLabel={tc("home")}>
      <p>{t("body")}</p>
      <p className="text-sm text-muted">
        {t("rolesLabel")}:{" "}
        {new Intl.ListFormat(currentLocale === "ar" ? "ar-EG" : "en-GB", {
          type: "conjunction",
        }).format(actor.roles.map((role) => tr(role)))}
      </p>
      <ul className="flex flex-col gap-3" data-testid="staff-duties">
        {duties.map((duty) => (
          <li key={duty.key}>
            <Link
              href={duty.href}
              className="flex min-h-11 items-center gap-4 rounded-lg border border-muted bg-surface p-4 hover:border-primary"
              data-testid={`staff-card-${duty.key}`}
            >
              <span className="flex flex-1 flex-col gap-1">
                <span className="text-lg font-bold text-primary">
                  {duty.title}
                </span>
                <span className="text-sm text-muted">{duty.description}</span>
              </span>
              {duty.count ? (
                <span
                  className="flex min-w-16 flex-col items-center rounded-lg bg-teal-50 px-3 py-2 text-center text-primary-strong"
                  data-testid={`staff-count-${duty.key}`}
                >
                  <span className="text-2xl font-bold leading-none">
                    {formatCount(duty.count.value, currentLocale)}
                  </span>
                  <span className="mt-1 text-xs">{duty.count.label}</span>
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </PageShell>
  );
}
