import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { AccountControls } from "@/modules/admin/ui/account-controls";
import { can, requireStaff } from "@/modules/identity/policy";
import { findAccountForStaff } from "@/modules/identity/suspension";
import { getDb } from "@/shared/db/client";
import { isLocale } from "@/shared/i18n/routing";
import { TextField } from "@/shared/ui/form";
import { PageShell, TextLink } from "@/shared/ui/page-shell";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const first = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v)?.slice(0, 254) || undefined;

// Account lookup and suspension (ADR-009): an exact email, never a listing.
// Moderators and super admins; anyone else with a staff role gets 404.
export default async function StaffAccountsPage({
  params,
  searchParams,
}: Props) {
  const { locale } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireStaff();
  if (!can(actor, "account.suspend")) notFound();
  const email = first((await searchParams).email)?.trim();
  const account = email
    ? await findAccountForStaff(getDb(), actor, email)
    : null;
  const t = await getTranslations("StaffAccounts");
  const tr = await getTranslations("Roles");
  const ts = await getTranslations("SuspensionReasons");
  const tl = await getTranslations("LiftReasons");
  const tc = await getTranslations("Common");
  const dateLocale = (await getLocale()) === "ar" ? "ar-EG" : "en-GB";
  const dayFormat = new Intl.DateTimeFormat(dateLocale, {
    dateStyle: "medium",
    timeZone: "Africa/Cairo",
  });
  const format = new Intl.DateTimeFormat(dateLocale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Cairo",
  });

  return (
    <PageShell title={t("title")} homeLabel={tc("home")}>
      <p className="text-muted">{t("intro")}</p>
      <form
        method="get"
        className="flex flex-col gap-4"
        data-testid="account-lookup"
      >
        <TextField
          name="email"
          type="email"
          label={t("emailLabel")}
          hint={t("emailHint")}
          autoComplete="off"
          inputMode="email"
          maxLength={254}
          defaultValue={email}
        />
        <button
          type="submit"
          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-5 font-semibold text-white hover:bg-primary-strong"
        >
          {t("find")}
        </button>
      </form>

      {email && !account ? (
        <p
          className="rounded-lg border border-muted bg-surface p-3"
          data-testid="account-not-found"
        >
          {t("notFound")}
        </p>
      ) : null}

      {account ? (
        <>
          <section
            aria-labelledby="account-heading"
            className="flex flex-col gap-2 rounded-lg border border-muted bg-surface p-3"
            data-testid="account-card"
            data-suspended={account.suspended}
          >
            <h2 id="account-heading" className="text-lg font-semibold">
              <bdi dir="ltr" className="break-all">
                {account.email}
              </bdi>
            </h2>
            <p>
              {t("statusLabel")}:{" "}
              <span
                className={`inline-flex items-center rounded border px-2 py-1 text-sm font-semibold ${
                  account.suspended
                    ? "border-red-700 bg-red-50 text-red-800"
                    : "border-primary bg-teal-50 text-primary-strong"
                }`}
                data-testid="account-status"
              >
                {account.suspended ? t("statusSuspended") : t("statusActive")}
              </span>
            </p>
            <p className="text-sm text-muted">
              {t("createdAt", {
                date: dayFormat.format(new Date(account.createdAt)),
              })}
              {" · "}
              {account.emailVerified
                ? t("emailVerified")
                : t("emailUnverified")}
            </p>
            <p className="text-sm">
              {t("rolesLabel")}:{" "}
              {account.roles.length > 0
                ? new Intl.ListFormat(locale, { type: "conjunction" }).format(
                    account.roles.map((r) => tr(r)),
                  )
                : t("noRoles")}
            </p>
          </section>

          {account.canAct ? (
            <AccountControls
              userId={account.userId}
              suspended={account.suspended}
            />
          ) : (
            <p
              className="rounded-lg border border-muted bg-surface p-3"
              role="note"
              data-testid="cannot-act"
            >
              {account.isSelf ? t("cannotActSelf") : t("cannotActStaff")}
            </p>
          )}

          <section
            aria-labelledby="history-heading"
            className="flex flex-col gap-3"
          >
            <h2 id="history-heading" className="text-xl font-bold">
              {t("historyHeading")}
            </h2>
            {account.history.length === 0 ? (
              <p className="text-muted" data-testid="history-empty">
                {t("historyEmpty")}
              </p>
            ) : (
              <ol className="flex flex-col gap-3" data-testid="history">
                {account.history.map((h) => (
                  <li
                    key={h.id}
                    className="flex flex-col gap-1 rounded-lg border border-muted bg-surface p-3"
                    data-testid="history-entry"
                  >
                    <span className="font-semibold">{ts(h.reasonCode)}</span>
                    <span className="text-sm text-muted">
                      {t("suspendedAt", {
                        date: format.format(new Date(h.suspendedAt)),
                      })}
                      {" · "}
                      {h.suspendedByEmail ? (
                        <>
                          {t("by")}{" "}
                          <bdi dir="ltr" className="break-all">
                            {h.suspendedByEmail}
                          </bdi>
                        </>
                      ) : (
                        t("byUnknown")
                      )}
                    </span>
                    {h.note ? (
                      <span className="text-sm">
                        {t("note")}: <bdi className="break-words">{h.note}</bdi>
                      </span>
                    ) : null}
                    {h.liftedAt && h.liftReasonCode ? (
                      <span className="border-t border-muted pt-1 text-sm">
                        {t("liftedAt", {
                          date: format.format(new Date(h.liftedAt)),
                        })}
                        {": "}
                        {tl(h.liftReasonCode)}
                        {" · "}
                        {h.liftedByEmail ? (
                          <>
                            {t("by")}{" "}
                            <bdi dir="ltr" className="break-all">
                              {h.liftedByEmail}
                            </bdi>
                          </>
                        ) : (
                          t("byUnknown")
                        )}
                      </span>
                    ) : (
                      <span className="text-sm font-semibold text-red-800">
                        {t("stillActive")}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      ) : null}
      <TextLink href="/staff">{t("staffLink")}</TextLink>
    </PageShell>
  );
}
