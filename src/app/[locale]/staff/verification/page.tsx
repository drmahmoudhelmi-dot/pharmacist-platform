import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { requireStaff } from "@/modules/identity/policy";
import { listQueue } from "@/modules/verification/service";
import { getDb } from "@/shared/db/client";
import { Link } from "@/shared/i18n/navigation";
import { isLocale } from "@/shared/i18n/routing";
import { PageShell, TextLink } from "@/shared/ui/page-shell";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
};

// The verification review queue (ADR-004, 4b): pending submissions, oldest
// first, masked national IDs only. Needs the verification_reviewer role and a
// session that passed TOTP.
export default async function VerificationQueuePage({
  params,
  searchParams,
}: Props) {
  const { locale } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireStaff("verification_reviewer");
  const { page } = await searchParams;
  const queue = await listQueue(
    getDb(),
    actor,
    typeof page === "string" ? page : 1,
  );
  const t = await getTranslations("StaffVerification");
  const tv = await getTranslations("Verification");
  const tc = await getTranslations("Common");
  const format = new Intl.DateTimeFormat(
    (await getLocale()) === "ar" ? "ar-EG" : "en-GB",
    { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" },
  );

  return (
    <PageShell title={t("queueTitle")} homeLabel={tc("home")}>
      <p className="text-muted">{t("queueIntro")}</p>
      {!queue || queue.items.length === 0 ? (
        <p
          className="rounded-lg border border-muted bg-surface p-3"
          data-testid="queue-empty"
        >
          {t("queueEmpty")}
        </p>
      ) : (
        <ol className="flex flex-col gap-3" data-testid="queue">
          {queue.items.map((item) => (
            <li key={item.id}>
              <Link
                href={`/staff/verification/${item.id}`}
                className="flex min-h-11 flex-col gap-1 rounded-lg border border-muted bg-surface p-3 hover:border-primary"
                data-testid="queue-item"
              >
                <span className="font-semibold">
                  {tv(`credentialTypes.${item.credentialType}`)}
                </span>
                <bdi dir="ltr" className="font-mono">
                  {item.nationalIdMasked}
                </bdi>
                <span className="text-sm text-muted">
                  {t("submittedAt", { date: format.format(item.submittedAt) })}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
      {queue && (queue.page > 1 || queue.hasMore) ? (
        <nav aria-label={t("pagination")} className="flex gap-4">
          {queue.page > 1 ? (
            <TextLink href={`/staff/verification?page=${queue.page - 1}`}>
              {t("previousPage")}
            </TextLink>
          ) : null}
          {queue.hasMore ? (
            <TextLink href={`/staff/verification?page=${queue.page + 1}`}>
              {t("nextPage")}
            </TextLink>
          ) : null}
        </nav>
      ) : null}
      <TextLink href="/staff">{t("staffLink")}</TextLink>
    </PageShell>
  );
}
