import { getTranslations, setRequestLocale } from "next-intl/server";
import { ResendVerificationForm } from "@/modules/identity/ui/resend-verification-form";
import { PageShell, TextLink } from "@/shared/ui/page-shell";
import { isLocale } from "@/shared/i18n/routing";

type Props = { params: Promise<{ locale: string }> };

export default async function CheckEmailPage({ params }: Props) {
  const { locale } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const t = await getTranslations("CheckEmail");
  const tc = await getTranslations("Common");
  return (
    <PageShell title={t("title")} homeLabel={tc("home")}>
      <p className="leading-relaxed">{t("body")}</p>
      <ResendVerificationForm />
      <TextLink href="/sign-in">{t("signInLink")}</TextLink>
    </PageShell>
  );
}
