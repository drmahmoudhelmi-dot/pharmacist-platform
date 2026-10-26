import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { listStaff } from "@/modules/admin/service";
import { StaffRolesPanel } from "@/modules/admin/ui/staff-roles-panel";
import { requireStaff } from "@/modules/identity/policy";
import { STAFF_ROLES } from "@/modules/identity/roles";
import { getDb } from "@/shared/db/client";
import { isLocale } from "@/shared/i18n/routing";
import { PageShell, TextLink } from "@/shared/ui/page-shell";

type Props = { params: Promise<{ locale: string }> };

// Staff role management (ADR-008): super admins only, with a TOTP session.
export default async function StaffRolesPage({ params }: Props) {
  const { locale } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireStaff("super_admin");
  const staff = await listStaff(getDb(), actor);
  const t = await getTranslations("StaffRoles");
  const tc = await getTranslations("Common");
  const format = new Intl.DateTimeFormat(
    (await getLocale()) === "ar" ? "ar-EG" : "en-GB",
    { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" },
  );
  const rows = staff.map((a) => ({
    userId: a.userId,
    email: a.email,
    isSelf: a.isSelf,
    roles: a.roles.map((r) => ({
      role: r.role,
      grantedAtLabel: r.grantedAt ? format.format(new Date(r.grantedAt)) : null,
      grantedByEmail: r.grantedByEmail,
    })),
  }));
  return (
    <PageShell title={t("title")} homeLabel={tc("home")}>
      <p className="text-muted">{t("intro")}</p>
      <StaffRolesPanel staff={rows} roles={[...STAFF_ROLES]} />
      <TextLink href="/staff">{t("staffLink")}</TextLink>
    </PageShell>
  );
}
