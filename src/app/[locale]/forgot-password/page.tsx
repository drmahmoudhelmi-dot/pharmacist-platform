import { getTranslations, setRequestLocale } from "next-intl/server";
import { ForgotPasswordForm } from "@/modules/identity/ui/forgot-password-form";
import { PageShell, TextLink } from "@/shared/ui/page-shell";
import { isLocale } from "@/shared/i18n/routing";

type Props = { params: Promise<{ locale: string }> };

export default async function ForgotPasswordPage({ params }: Props) {
  const { locale } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const t = await getTranslations("ForgotPassword");
  const tc = await getTranslations("Common");
  return (
    <PageShell title={t("title")} homeLabel={tc("home")}>
      <ForgotPasswordForm />
      <TextLink href="/sign-in">{t("signInLink")}</TextLink>
    </PageShell>
  );
}
