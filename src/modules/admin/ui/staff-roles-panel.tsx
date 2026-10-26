"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { useRouter } from "@/shared/i18n/navigation";
import {
  FormStatus,
  SecondaryButton,
  SelectField,
  SubmitButton,
  TextField,
} from "@/shared/ui/form";
import { grantRoleAction, revokeRoleAction } from "../actions";

export type StaffRow = {
  userId: string;
  email: string;
  isSelf: boolean;
  roles: {
    role: string;
    grantedAtLabel: string | null;
    grantedByEmail: string | null;
  }[];
};

type Status = { error: string | null; success: string | null };

/**
 * The staff list with revoke buttons (asking first) and the grant form. One
 * component so a message survives the list refreshing after a change.
 */
export function StaffRolesPanel({
  staff,
  roles,
}: {
  staff: StaffRow[];
  roles: string[];
}) {
  const t = useTranslations("StaffRoles");
  const te = useTranslations("StaffRoleErrors");
  const tr = useTranslations("Roles");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<Status>({ error: null, success: null });
  const [confirming, setConfirming] = useState<string | null>(null);

  async function run(
    call: () => ReturnType<typeof grantRoleAction>,
    form?: HTMLFormElement,
  ) {
    setPending(true);
    setStatus({ error: null, success: null });
    setConfirming(null);
    try {
      const result = await call();
      if (result.ok) {
        setStatus({ error: null, success: t(`result.${result.status}`) });
        form?.reset();
        router.refresh();
      } else {
        setStatus({ error: te(result.error), success: null });
      }
    } catch {
      setStatus({ error: te("network"), success: null });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="rounded-lg border border-muted bg-surface p-3 text-sm">
        {t("signOutNote")}
      </p>
      <ul className="flex flex-col gap-3" data-testid="staff-list">
        {staff.map((account) => (
          <li
            key={account.userId}
            className="flex flex-col gap-2 rounded-lg border border-muted bg-surface p-3"
            data-testid="staff-account"
          >
            <bdi dir="ltr" className="break-all font-semibold">
              {account.email}
            </bdi>
            {account.isSelf ? (
              <p className="text-sm text-muted" data-testid="self-note">
                {t("selfNote")}
              </p>
            ) : null}
            <ul className="flex flex-col gap-2">
              {account.roles.map((r) => {
                const key = `${account.userId}:${r.role}`;
                return (
                  <li
                    key={r.role}
                    className="flex flex-col gap-1 border-t border-muted pt-2"
                    data-testid="staff-role"
                  >
                    <span className="font-semibold">{tr(r.role)}</span>
                    <span className="text-sm text-muted">
                      {r.grantedAtLabel
                        ? t("grantedAt", { date: r.grantedAtLabel })
                        : t("grantedUnknown")}
                      {" · "}
                      {r.grantedByEmail ? (
                        <>
                          {t("grantedBy")}{" "}
                          <bdi dir="ltr" className="break-all">
                            {r.grantedByEmail}
                          </bdi>
                        </>
                      ) : (
                        t("grantedByOperator")
                      )}
                    </span>
                    {account.isSelf ? null : confirming === key ? (
                      <div className="flex flex-col gap-2" role="group">
                        <p>
                          {t("revokeConfirm", { role: tr(r.role) })}{" "}
                          <bdi dir="ltr" className="break-all">
                            {account.email}
                          </bdi>
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <SecondaryButton
                            tone="danger"
                            disabled={pending}
                            onClick={() =>
                              void run(() =>
                                revokeRoleAction(account.email, r.role),
                              )
                            }
                          >
                            {t("confirmRevoke")}
                          </SecondaryButton>
                          <SecondaryButton onClick={() => setConfirming(null)}>
                            {t("cancel")}
                          </SecondaryButton>
                        </div>
                      </div>
                    ) : (
                      <div>
                        <SecondaryButton
                          tone="danger"
                          disabled={pending}
                          onClick={() => setConfirming(key)}
                        >
                          {t("revoke", { role: tr(r.role) })}
                        </SecondaryButton>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>

      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const form = e.currentTarget;
          void run(() => grantRoleAction(new FormData(form)), form);
        }}
      >
        <h2 className="text-xl font-bold">{t("grantTitle")}</h2>
        <TextField
          name="email"
          type="email"
          label={t("emailLabel")}
          hint={t("emailHint")}
          autoComplete="off"
          inputMode="email"
          maxLength={254}
        />
        <SelectField
          name="role"
          label={t("roleLabel")}
          placeholder={t("rolePlaceholder")}
          options={roles.map((r) => ({ value: r, label: tr(r) }))}
        />
        <SubmitButton
          pending={pending}
          label={t("grant")}
          pendingLabel={t("granting")}
        />
      </form>
      <FormStatus error={status.error} success={status.success} />
    </div>
  );
}
