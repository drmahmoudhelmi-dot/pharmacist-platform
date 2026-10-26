"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/shared/i18n/navigation";
import { FormStatus, SecondaryButton } from "@/shared/ui/form";
import { respondToInvitationAction } from "../actions";
import type { MyInvitation } from "../service";
import { useWrite } from "./use-write";

/** Invitations addressed to the signed-in user, with Accept and Decline. */
export function MyInvitations({
  invitations,
}: {
  invitations: readonly MyInvitation[];
}) {
  return (
    <ul className="flex flex-col gap-3" data-testid="my-invitations">
      {invitations.map((invitation) => (
        <InvitationRow key={invitation.id} invitation={invitation} />
      ))}
    </ul>
  );
}

function InvitationRow({ invitation }: { invitation: MyInvitation }) {
  const t = useTranslations("Organizations");
  const tr = useTranslations("OrganizationRoles");
  const tk = useTranslations("OrganizationKinds");
  const locale = useLocale();
  const router = useRouter();
  const write = useWrite<never, { organizationId?: string }>();
  const expires = new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", {
    timeZone: "Africa/Cairo",
    dateStyle: "medium",
  }).format(new Date(invitation.expiresAt));

  async function answer(choice: "accept" | "decline") {
    const result = await write.submit(
      null,
      () => respondToInvitationAction(invitation.id, choice),
      choice === "accept" ? t("accepted") : t("declined"),
    );
    if (choice === "accept" && result?.ok && result.organizationId)
      router.push(`/organizations/${result.organizationId}`);
  }

  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-primary bg-surface p-3"
      data-testid="my-invitation"
    >
      <p>
        {t("invitationText", {
          role: tr(invitation.role),
        })}{" "}
        <bdi className="font-semibold">{invitation.organizationName}</bdi>{" "}
        <span className="text-sm text-muted">({tk(invitation.kind)})</span>
      </p>
      <p className="text-sm text-muted">{t("expiresOn", { date: expires })}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={write.pending}
          onClick={() => void answer("accept")}
          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-5 font-semibold text-white hover:bg-primary-strong disabled:opacity-70"
        >
          {t("accept")}
        </button>
        <SecondaryButton
          disabled={write.pending}
          onClick={() => void answer("decline")}
        >
          {t("decline")}
        </SecondaryButton>
      </div>
      <FormStatus error={write.error} success={write.success} />
    </li>
  );
}
