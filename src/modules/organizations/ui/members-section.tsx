"use client";

import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { useRouter } from "@/shared/i18n/navigation";
import {
  FormStatus,
  SecondaryButton,
  SelectField,
  SubmitButton,
  TextField,
} from "@/shared/ui/form";
import {
  changeMemberRoleAction,
  inviteMemberAction,
  leaveOrganizationAction,
  removeMemberAction,
  revokeInvitationAction,
} from "../actions";
import { LIMITS, MEMBER_ROLES, type MemberRole } from "../constants";
import type { InvitationView, MemberView } from "../service";
import {
  formDataToRaw,
  type InvitationField,
  parseInvitation,
} from "../validation";
import { useWrite } from "./use-write";

/**
 * What the signed-in member may do, computed on the server with the policy.
 * Only decides which controls to show; every action is checked again.
 */
export type MemberPermissions = {
  myRole: MemberRole;
  invitableRoles: readonly MemberRole[];
};

/** Roles an actor may act on: owners any, admins recruiters only. */
const manageable = (myRole: MemberRole, role: MemberRole) =>
  myRole === "owner" || (myRole === "admin" && role === "recruiter");

const cairoDate = (iso: string, locale: string) =>
  new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", {
    timeZone: "Africa/Cairo",
    dateStyle: "medium",
  }).format(new Date(iso));

export function MembersList({
  organizationId,
  members,
  myRole,
}: {
  organizationId: string;
  members: readonly MemberView[];
  myRole: MemberRole;
}) {
  const t = useTranslations("Organizations");
  return (
    <ul className="flex flex-col gap-3" data-testid="member-list">
      {members.map((member) => (
        <MemberRow
          key={member.id}
          organizationId={organizationId}
          member={member}
          myRole={myRole}
          selfLabel={t("you")}
        />
      ))}
    </ul>
  );
}

function MemberRow({
  organizationId,
  member,
  myRole,
  selfLabel,
}: {
  organizationId: string;
  member: MemberView;
  myRole: MemberRole;
  selfLabel: string;
}) {
  const t = useTranslations("Organizations");
  const tr = useTranslations("OrganizationRoles");
  const write = useWrite();
  const [confirming, setConfirming] = useState(false);
  const canChangeRole = myRole === "owner" && !member.isSelf;
  const canRemove = !member.isSelf && manageable(myRole, member.role);

  async function onRoleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const role = String(new FormData(event.currentTarget).get("role") ?? "");
    await write.submit(
      null,
      () => changeMemberRoleAction(organizationId, member.id, role),
      t("roleChanged"),
    );
  }

  return (
    <li
      className="flex flex-col gap-2 rounded-lg border border-muted bg-surface p-3"
      data-testid="member-row"
    >
      <p className="flex flex-wrap items-center gap-2">
        <bdi dir="ltr" className="break-all font-semibold">
          {member.email ?? "—"}
        </bdi>
        {member.isSelf ? (
          <span className="text-sm text-muted">({selfLabel})</span>
        ) : null}
        <span
          className="rounded bg-canvas px-2 py-1 text-sm font-semibold"
          data-testid="member-role"
        >
          {tr(member.role)}
        </span>
      </p>
      {canChangeRole ? (
        <form
          noValidate
          onSubmit={onRoleSubmit}
          className="flex flex-col gap-2"
        >
          <SelectField
            name="role"
            label={t("changeRoleLabel")}
            options={MEMBER_ROLES.map((value) => ({
              value,
              label: tr(value),
            }))}
            defaultValue={member.role}
          />
          <SubmitButton
            pending={write.pending}
            label={t("changeRole")}
            pendingLabel={t("saving")}
          />
        </form>
      ) : null}
      {canRemove ? (
        confirming ? (
          <div className="flex flex-col gap-2" role="group">
            <p>{t("removeConfirm")}</p>
            <div className="flex flex-wrap gap-2">
              <SecondaryButton
                tone="danger"
                disabled={write.pending}
                onClick={() =>
                  void write.submit(
                    null,
                    () => removeMemberAction(organizationId, member.id),
                    t("removed"),
                  )
                }
              >
                {t("confirmRemove")}
              </SecondaryButton>
              <SecondaryButton onClick={() => setConfirming(false)}>
                {t("cancel")}
              </SecondaryButton>
            </div>
          </div>
        ) : (
          <SecondaryButton tone="danger" onClick={() => setConfirming(true)}>
            {t("remove")}
          </SecondaryButton>
        )
      ) : null}
      <FormStatus error={write.error} success={write.success} />
    </li>
  );
}

export function InviteForm({
  organizationId,
  permissions,
}: {
  organizationId: string;
  permissions: MemberPermissions;
}) {
  const t = useTranslations("Organizations");
  const tr = useTranslations("OrganizationRoles");
  const write = useWrite<InvitationField>();
  const [formKey, setFormKey] = useState(0);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = parseInvitation(formDataToRaw(form));
    const result = await write.submit(
      parsed.ok ? null : parsed.fieldErrors,
      () => inviteMemberAction(organizationId, form),
      t("invited"),
    );
    // A fresh, empty form for the next invitation.
    if (result?.ok) setFormKey((k) => k + 1);
  }

  return (
    <form
      key={formKey}
      noValidate
      onSubmit={onSubmit}
      className="flex flex-col gap-4"
    >
      <TextField
        name="email"
        type="email"
        label={t("inviteEmailLabel")}
        hint={t("inviteEmailHint")}
        autoComplete="off"
        inputMode="email"
        maxLength={LIMITS.email.max}
        error={write.fieldError("email")}
      />
      <SelectField
        name="role"
        label={t("inviteRoleLabel")}
        hint={t("roleHint")}
        options={permissions.invitableRoles.map((value) => ({
          value,
          label: tr(value),
        }))}
        defaultValue="recruiter"
        error={write.fieldError("role")}
      />
      <FormStatus error={write.error} success={write.success} />
      <SubmitButton
        pending={write.pending}
        label={t("invite")}
        pendingLabel={t("saving")}
      />
    </form>
  );
}

export function PendingInvitations({
  organizationId,
  invitations,
  myRole,
}: {
  organizationId: string;
  invitations: readonly InvitationView[];
  myRole: MemberRole;
}) {
  const t = useTranslations("Organizations");
  if (invitations.length === 0)
    return (
      <p className="text-muted" data-testid="invitations-empty">
        {t("invitationsEmpty")}
      </p>
    );
  return (
    <ul className="flex flex-col gap-3" data-testid="invitation-list">
      {invitations.map((invitation) => (
        <PendingInvitationRow
          key={invitation.id}
          organizationId={organizationId}
          invitation={invitation}
          canRevoke={manageable(myRole, invitation.role)}
        />
      ))}
    </ul>
  );
}

function PendingInvitationRow({
  organizationId,
  invitation,
  canRevoke,
}: {
  organizationId: string;
  invitation: InvitationView;
  canRevoke: boolean;
}) {
  const t = useTranslations("Organizations");
  const tr = useTranslations("OrganizationRoles");
  const locale = useLocale();
  const write = useWrite();
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-muted bg-surface p-3">
      <p className="flex flex-wrap items-center gap-2">
        <bdi dir="ltr" className="break-all font-semibold">
          {invitation.email}
        </bdi>
        <span className="rounded bg-canvas px-2 py-1 text-sm font-semibold">
          {tr(invitation.role)}
        </span>
      </p>
      <p className="text-sm text-muted">
        {t("expiresOn", { date: cairoDate(invitation.expiresAt, locale) })}
      </p>
      {canRevoke ? (
        <SecondaryButton
          tone="danger"
          disabled={write.pending}
          onClick={() =>
            void write.submit(
              null,
              () => revokeInvitationAction(organizationId, invitation.id),
              t("revoked"),
            )
          }
        >
          {t("revoke")}
        </SecondaryButton>
      ) : null}
      <FormStatus error={write.error} success={write.success} />
    </li>
  );
}

export function LeaveOrganization({
  organizationId,
}: {
  organizationId: string;
}) {
  const t = useTranslations("Organizations");
  const router = useRouter();
  const write = useWrite();
  const [confirming, setConfirming] = useState(false);

  async function leave() {
    const result = await write.submit(
      null,
      () => leaveOrganizationAction(organizationId),
      t("left"),
    );
    if (result?.ok) router.push("/organizations");
  }

  return (
    <div className="flex flex-col gap-2">
      {confirming ? (
        <div className="flex flex-col gap-2" role="group">
          <p>{t("leaveConfirm")}</p>
          <div className="flex flex-wrap gap-2">
            <SecondaryButton
              tone="danger"
              disabled={write.pending}
              onClick={() => void leave()}
            >
              {t("confirmLeave")}
            </SecondaryButton>
            <SecondaryButton onClick={() => setConfirming(false)}>
              {t("cancel")}
            </SecondaryButton>
          </div>
        </div>
      ) : (
        <SecondaryButton tone="danger" onClick={() => setConfirming(true)}>
          {t("leave")}
        </SecondaryButton>
      )}
      <FormStatus error={write.error} success={write.success} />
    </div>
  );
}
