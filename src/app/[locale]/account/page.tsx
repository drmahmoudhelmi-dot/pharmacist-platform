import { getTranslations, setRequestLocale } from "next-intl/server";
import { getAccountView } from "@/modules/identity/account";
import { requireActor } from "@/modules/identity/policy";
import {
  SessionActions,
  TwoFactorPanel,
} from "@/modules/identity/ui/account-panel";
import { PageShell, TextLink } from "@/shared/ui/page-shell";
import { isLocale } from "@/shared/i18n/routing";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ notice?: string | string[] }>;
};

const NOTICES = ["staff_denied", "staff_mfa_required"] as const;

export default async function AccountPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireActor();
  const account = await getAccountView(actor);
  const { notice } = await searchParams;
  const t = await getTranslations("Account");
  const tc = await getTranslations("Common");
  const noticeKey = NOTICES.find((n) => n === notice);

  return (
    <PageShell title={t("title")} homeLabel={tc("home")}>
      {noticeKey ? (
        <p
          role="alert"
          className="rounded-lg border border-red-700 bg-red-50 p-3 text-red-800"
        >
          {t(`notices.${noticeKey}`)}
        </p>
      ) : null}
      {account ? (
        <>
          <section
            className="flex flex-col gap-2"
            aria-labelledby="email-heading"
          >
            <h2 id="email-heading" className="text-lg font-semibold">
              {t("emailHeading")}
            </h2>
            <p>
              <bdi dir="ltr" data-testid="account-email">
                {account.email}
              </bdi>{" "}
              <span className="rounded bg-canvas px-2 py-1 text-sm font-semibold">
                {account.emailVerified ? t("verified") : t("notVerified")}
              </span>
            </p>
          </section>
          <section
            className="flex flex-col gap-3"
            aria-labelledby="totp-heading"
          >
            <h2 id="totp-heading" className="text-lg font-semibold">
              {t("totpHeading")}:{" "}
              <span data-testid="totp-state">
                {account.twoFactorEnabled ? t("totpOn") : t("totpOff")}
              </span>
            </h2>
            <p className="text-muted">{t("totpExplain")}</p>
            <TwoFactorPanel enabled={account.twoFactorEnabled} />
          </section>
          <section
            className="flex flex-col gap-2"
            aria-labelledby="profile-heading"
          >
            <h2 id="profile-heading" className="text-lg font-semibold">
              {t("profileHeading")}
            </h2>
            <TextLink href="/profile">{t("profileLink")}</TextLink>
          </section>
          <section
            className="flex flex-col gap-2"
            aria-labelledby="verification-heading"
          >
            <h2 id="verification-heading" className="text-lg font-semibold">
              {t("verificationHeading")}
            </h2>
            <p className="text-muted">{t("verificationExplain")}</p>
            <TextLink href="/verification">{t("verificationLink")}</TextLink>
          </section>
          <section
            className="flex flex-col gap-2"
            aria-labelledby="data-heading"
          >
            <h2 id="data-heading" className="text-lg font-semibold">
              {t("dataHeading")}
            </h2>
            <p className="text-muted">{t("dataExplain")}</p>
            {/* A plain link: the route answers with a JSON attachment. */}
            <a
              href="/api/account/export"
              download
              className="inline-flex min-h-11 items-center justify-center rounded-lg border border-primary px-5 font-semibold text-primary hover:bg-primary hover:text-white"
            >
              {t("downloadData")}
            </a>
          </section>
          {account.isStaff ? (
            <TextLink href="/staff">{t("staffLink")}</TextLink>
          ) : null}
        </>
      ) : null}
      <section
        className="flex flex-col gap-3"
        aria-labelledby="sessions-heading"
      >
        <h2 id="sessions-heading" className="text-lg font-semibold">
          {t("sessionsHeading")}
        </h2>
        <SessionActions />
      </section>
    </PageShell>
  );
}
