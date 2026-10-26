import { getTranslations, setRequestLocale } from "next-intl/server";
import { can, requireStaff } from "@/modules/identity/policy";
import { PageShell, TextLink } from "@/shared/ui/page-shell";
import { isLocale } from "@/shared/i18n/routing";

type Props = { params: Promise<{ locale: string }> };

// Placeholder for the admin step (step 7). The guard is the real content:
// a staff role, TOTP enabled and a session that passed it.
export default async function StaffPage({ params }: Props) {
  const { locale } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireStaff();
  const t = await getTranslations("Staff");
  const tr = await getTranslations("Roles");
  const tc = await getTranslations("Common");
  return (
    <PageShell title={t("title")} homeLabel={tc("home")}>
      <p>{t("body")}</p>
      <p>
        {t("rolesLabel")}:{" "}
        {new Intl.ListFormat(locale, { type: "conjunction" }).format(
          actor.roles.map((role) => tr(role)),
        )}
      </p>
      {can(actor, "verification.review") ? (
        <TextLink href="/staff/verification">{t("verificationLink")}</TextLink>
      ) : null}
      {can(actor, "moderation.access") ? (
        <TextLink href="/staff/jobs">{t("jobsLink")}</TextLink>
      ) : null}
    </PageShell>
  );
}
