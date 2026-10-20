import { getTranslations, setRequestLocale } from "next-intl/server";
import { ResetPasswordForm } from "@/modules/identity/ui/reset-password-form";
import { PageShell, TextLink } from "@/shared/ui/page-shell";
import { isLocale } from "@/shared/i18n/routing";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ token?: string | string[] }>;
};

export default async function ResetPasswordPage({
  params,
  searchParams,
}: Props) {
  const { locale } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const { token } = await searchParams;
  const t = await getTranslations("ResetPassword");
  const tc = await getTranslations("Common");
  // The token is checked by the server when the form is submitted.
  return (
    <PageShell title={t("title")} homeLabel={tc("home")}>
      {typeof token === "string" && token.length > 0 ? (
        <ResetPasswordForm token={token} />
      ) : (
        <>
          <p
            role="alert"
            className="rounded-lg border border-red-700 bg-red-50 p-3 text-red-800"
          >
            {t("missing")}
          </p>
          <TextLink href="/forgot-password">{t("requestNew")}</TextLink>
        </>
      )}
    </PageShell>
  );
}
