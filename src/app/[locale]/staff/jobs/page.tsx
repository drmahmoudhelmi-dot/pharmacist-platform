import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { requireStaff } from "@/modules/identity/policy";
import { listReviewQueue } from "@/modules/jobs/service";
import { getDb } from "@/shared/db/client";
import { Link } from "@/shared/i18n/navigation";
import { isLocale } from "@/shared/i18n/routing";
import { PageShell, TextLink } from "@/shared/ui/page-shell";

type Props = { params: Promise<{ locale: string }> };

// The moderation queue for jobs (ADR-006): pending jobs, oldest first. Needs
// the moderator role and a session that passed TOTP.
export default async function JobQueuePage({ params }: Props) {
  const { locale } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireStaff("moderator");
  const queue = await listReviewQueue(getDb(), actor);
  const t = await getTranslations("StaffJobs");
  const tc = await getTranslations("Common");
  const format = new Intl.DateTimeFormat(
    (await getLocale()) === "ar" ? "ar-EG" : "en-GB",
    { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" },
  );

  return (
    <PageShell title={t("queueTitle")} homeLabel={tc("home")}>
      <p className="text-muted">{t("queueIntro")}</p>
      {queue.length === 0 ? (
        <p
          className="rounded-lg border border-muted bg-surface p-3"
          data-testid="queue-empty"
        >
          {t("queueEmpty")}
        </p>
      ) : (
        <ol className="flex flex-col gap-3" data-testid="queue">
          {queue.map((item) => (
            <li key={item.id}>
              <Link
                href={`/staff/jobs/${item.id}`}
                className="flex min-h-11 flex-col gap-1 rounded-lg border border-muted bg-surface p-3 hover:border-primary"
                data-testid="queue-item"
              >
                <bdi className="font-semibold">{item.title}</bdi>
                <bdi>{item.organizationName}</bdi>
                <span className="text-sm text-muted">
                  {item.posterVerified
                    ? t("verifiedPoster")
                    : t("unverifiedPoster")}{" "}
                  ·{" "}
                  {t("submittedAt", {
                    date: format.format(new Date(item.submittedAt)),
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
