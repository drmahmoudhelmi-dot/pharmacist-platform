import { getTranslations, setRequestLocale } from "next-intl/server";
import { headers } from "next/headers";
import { verifyEmailToken } from "@/modules/identity/email-verification";
import { PageShell, TextLink } from "@/shared/ui/page-shell";
import { isLocale } from "@/shared/i18n/routing";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string | string[] }>;
};

export default async function VerifyEmailPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const { token } = await searchParams;
  const t = await getTranslations("VerifyEmail");
  const tc = await getTranslations("Common");

  // The result shown is the server's: the token is checked here, not in the browser.
  const outcome =
    typeof token === "string" && token.length > 0
      ? await verifyEmailToken(token, await headers())
      : "missing";

  return (
    <PageShell title={t("title")} homeLabel={tc("home")}>
      {outcome === "verified" ? (
        <>
          <p
            role="status"
            className="rounded-lg border border-primary bg-teal-50 p-3 text-primary-strong"
          >
            {t("success")}
          </p>
          <TextLink href="/sign-in">{t("signInLink")}</TextLink>
        </>
      ) : (
        <>
          <p
            role="alert"
            className="rounded-lg border border-red-700 bg-red-50 p-3 text-red-800"
          >
            {outcome === "missing" ? t("missing") : t("invalid")}
          </p>
          <TextLink href="/check-email">{t("resendLink")}</TextLink>
        </>
      )}
    </PageShell>
  );
}
