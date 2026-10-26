import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { requireActor } from "@/modules/identity/policy";
import { MEMBER_ROLES } from "@/modules/organizations/constants";
import { can } from "@/modules/organizations/policy";
import {
  getOrganizationForMember,
  listMembers,
  listPendingInvitations,
} from "@/modules/organizations/service";
import {
  InviteForm,
  LeaveOrganization,
  MembersList,
  PendingInvitations,
} from "@/modules/organizations/ui/members-section";
import { OrganizationForm } from "@/modules/organizations/ui/organization-form";
import { listGovernorates } from "@/modules/profiles/service";
import { getDb } from "@/shared/db/client";
import { isLocale } from "@/shared/i18n/routing";
import { PageShell, TextLink } from "@/shared/ui/page-shell";

type Props = { params: Promise<{ locale: string; id: string }> };

// Organization ids are not known at build time (see the locale layout).
export const dynamicParams = true;

/**
 * One organization, for its members only. A missing organization, a
 * malformed id and someone else's organization all get the same 404.
 * Owners also see the edit form, members and invitations.
 */
export default async function OrganizationPage({ params }: Props) {
  const { locale, id } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireActor();
  const db = getDb();
  const view = await getOrganizationForMember(db, actor, id);
  if (!view) notFound();
  const role = { actorRole: view.myRole };
  const manages = can(actor, "organization.update", role);
  const [members, invitations, governorates] = manages
    ? await Promise.all([
        listMembers(db, actor, view.id),
        listPendingInvitations(db, actor, view.id),
        listGovernorates(db),
      ])
    : [[], [], []];
  const invitableRoles = MEMBER_ROLES.filter((targetRole) =>
    can(actor, "invitation.create", { ...role, targetRole }),
  );

  const t = await getTranslations("Organizations");
  const tr = await getTranslations("OrganizationRoles");
  const tk = await getTranslations("OrganizationKinds");
  const tc = await getTranslations("Common");
  const governorateName = view.governorate
    ? locale === "en"
      ? view.governorate.nameEn
      : view.governorate.nameAr
    : null;

  return (
    <PageShell title={view.name} homeLabel={tc("home")}>
      <section
        aria-labelledby="details-heading"
        className="flex flex-col gap-2 rounded-lg border border-muted bg-surface p-3"
      >
        <h2 id="details-heading" className="text-lg font-semibold">
          {t("detailsHeading")}
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="font-semibold">{t("kindLegend")}</dt>
          <dd data-testid="organization-kind">{tk(view.kind)}</dd>
          <dt className="font-semibold">{t("governorateLabel")}</dt>
          <dd>{governorateName ?? "—"}</dd>
          <dt className="font-semibold">{t("addressLabel")}</dt>
          <dd>
            <bdi>{view.addressLine ?? "—"}</bdi>
          </dd>
          <dt className="font-semibold">{t("myRoleLabel")}</dt>
          <dd data-testid="my-role">{tr(view.myRole)}</dd>
        </dl>
        <p className="text-sm text-muted">{t("notVerifiedNote")}</p>
      </section>
      {manages ? (
        <>
          <section
            aria-labelledby="edit-heading"
            className="flex flex-col gap-3"
          >
            <h2 id="edit-heading" className="text-lg font-semibold">
              {t("editHeading")}
            </h2>
            <OrganizationForm organization={view} governorates={governorates} />
          </section>
          <section
            aria-labelledby="members-heading"
            className="flex flex-col gap-3"
          >
            <h2 id="members-heading" className="text-lg font-semibold">
              {t("membersHeading")}
            </h2>
            <MembersList
              organizationId={view.id}
              members={members}
              myRole={view.myRole}
            />
          </section>
          <section
            aria-labelledby="invite-heading"
            className="flex flex-col gap-3"
          >
            <h2 id="invite-heading" className="text-lg font-semibold">
              {t("inviteHeading")}
            </h2>
            <p className="text-muted">{t("inviteExplain")}</p>
            <InviteForm
              organizationId={view.id}
              permissions={{ myRole: view.myRole, invitableRoles }}
            />
            <h3 className="font-semibold">{t("pendingHeading")}</h3>
            <PendingInvitations
              organizationId={view.id}
              invitations={invitations}
              myRole={view.myRole}
            />
          </section>
        </>
      ) : (
        <p className="text-muted">{t("recruiterNote")}</p>
      )}
      <section aria-labelledby="leave-heading" className="flex flex-col gap-2">
        <h2 id="leave-heading" className="text-lg font-semibold">
          {t("leaveHeading")}
        </h2>
        <LeaveOrganization organizationId={view.id} />
      </section>
      <TextLink href="/organizations">{t("backToList")}</TextLink>
    </PageShell>
  );
}
