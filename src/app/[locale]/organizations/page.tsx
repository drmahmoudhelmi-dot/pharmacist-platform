import { getTranslations, setRequestLocale } from "next-intl/server";
import { requireActor } from "@/modules/identity/policy";
import {
  listMyInvitations,
  listMyOrganizations,
} from "@/modules/organizations/service";
import { MyInvitations } from "@/modules/organizations/ui/my-invitations";
import { OrganizationForm } from "@/modules/organizations/ui/organization-form";
import { listGovernorates } from "@/modules/profiles/service";
import { getDb } from "@/shared/db/client";
import { Link } from "@/shared/i18n/navigation";
import { isLocale } from "@/shared/i18n/routing";
import { PageShell, TextLink } from "@/shared/ui/page-shell";

type Props = { params: Promise<{ locale: string }> };

// The signed-in user's organizations, the invitations addressed to their
// verified email, and the form to create an organization (ADR-005).
export default async function OrganizationsPage({ params }: Props) {
  const { locale } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireActor();
  const db = getDb();
  const [organizations, invitations, governorates] = await Promise.all([
    listMyOrganizations(db, actor),
    listMyInvitations(db, actor),
    listGovernorates(db),
  ]);
  const t = await getTranslations("Organizations");
  const tr = await getTranslations("OrganizationRoles");
  const tk = await getTranslations("OrganizationKinds");
  const tc = await getTranslations("Common");

  return (
    <PageShell title={t("title")} homeLabel={tc("home")}>
      <p className="text-muted">{t("intro")}</p>
      {invitations.length > 0 ? (
        <section
          aria-labelledby="invitations-heading"
          className="flex flex-col gap-3"
        >
          <h2 id="invitations-heading" className="text-lg font-semibold">
            {t("myInvitationsHeading")}
          </h2>
          <MyInvitations invitations={invitations} />
        </section>
      ) : null}
      <section aria-labelledby="mine-heading" className="flex flex-col gap-3">
        <h2 id="mine-heading" className="text-lg font-semibold">
          {t("mineHeading")}
        </h2>
        {organizations.length === 0 ? (
          <p
            className="rounded-lg border border-muted bg-surface p-3"
            data-testid="organizations-empty"
          >
            {t("empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="organization-list">
            {organizations.map((o) => (
              <li key={o.id}>
                <Link
                  href={`/organizations/${o.id}`}
                  className="flex min-h-11 flex-wrap items-center gap-2 rounded-lg border border-muted bg-surface p-3 font-semibold text-primary underline-offset-4 hover:underline"
                >
                  <bdi>{o.name}</bdi>
                  <span className="text-sm font-normal text-muted">
                    {tk(o.kind)} · {tr(o.role)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="create-heading" className="flex flex-col gap-3">
        <h2 id="create-heading" className="text-lg font-semibold">
          {t("createHeading")}
        </h2>
        <p className="text-muted">{t("createExplain")}</p>
        <OrganizationForm governorates={governorates} />
      </section>
      <TextLink href="/account">{t("accountLink")}</TextLink>
    </PageShell>
  );
}
