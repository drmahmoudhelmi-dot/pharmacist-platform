import { getTranslations, setRequestLocale } from "next-intl/server";
import { SignUpForm } from "@/modules/identity/ui/sign-up-form";
import { PageShell, TextLink } from "@/shared/ui/page-shell";
import { isLocale } from "@/shared/i18n/routing";

type Props = { params: Promise<{ locale: string }> };

export default async function SignUpPage({ params }: Props) {
  const { locale } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const t = await getTranslations("SignUp");
  const tc = await getTranslations("Common");
  return (
    <PageShell title={t("title")} homeLabel={tc("home")}>
      <SignUpForm />
      <p className="text-muted">
        {t("haveAccount")}{" "}
        <TextLink href="/sign-in">{t("signInLink")}</TextLink>
      </p>
    </PageShell>
  );
}
