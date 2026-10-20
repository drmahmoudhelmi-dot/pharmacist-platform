import { getTranslations, setRequestLocale } from "next-intl/server";
import { SignInForm } from "@/modules/identity/ui/sign-in-form";
import { PageShell, TextLink } from "@/shared/ui/page-shell";
import { isLocale } from "@/shared/i18n/routing";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ notice?: string | string[] }>;
};

const NOTICES = {
  password_reset: "passwordReset",
  signed_out: "signedOut",
} as const;

export default async function SignInPage({ params, searchParams }: Props) {
  const { locale } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const { notice } = await searchParams;
  const t = await getTranslations("SignIn");
  const tc = await getTranslations("Common");
  const noticeKey =
    typeof notice === "string" && Object.hasOwn(NOTICES, notice)
      ? NOTICES[notice as keyof typeof NOTICES]
      : null;
  return (
    <PageShell title={t("title")} homeLabel={tc("home")}>
      {noticeKey ? (
        <p
          role="status"
          className="rounded-lg border border-primary bg-teal-50 p-3 text-primary-strong"
        >
          {t(noticeKey)}
        </p>
      ) : null}
      <SignInForm />
      <TextLink href="/forgot-password">{t("forgotLink")}</TextLink>
      <p className="text-muted">
        {t("noAccount")} <TextLink href="/sign-up">{t("signUpLink")}</TextLink>
      </p>
    </PageShell>
  );
}
