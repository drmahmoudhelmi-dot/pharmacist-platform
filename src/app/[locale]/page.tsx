import { getTranslations, setRequestLocale } from "next-intl/server";
import { getActor } from "@/modules/identity/policy";
import { Link } from "@/shared/i18n/navigation";
import { isLocale } from "@/shared/i18n/routing";

type Props = { params: Promise<{ locale: string }> };

const primaryLink =
  "inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-5 font-semibold text-white hover:bg-primary-strong";
const secondaryLink =
  "inline-flex min-h-11 items-center justify-center rounded-lg border border-primary px-5 font-semibold text-primary hover:bg-primary hover:text-white";

export default async function HomePage({ params }: Props) {
  const { locale: routeLocale } = await params;
  const locale = isLocale(routeLocale) ? routeLocale : "ar";
  setRequestLocale(locale);

  const t = await getTranslations("Home");
  // Only decides which links to show; every page checks access itself.
  const signedIn = (await getActor()) !== null;
  const otherLocale = locale === "ar" ? "en" : "ar";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-6 px-4 py-6">
      <header className="flex justify-end">
        <Link
          href="/"
          locale={otherLocale}
          lang={otherLocale}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-primary px-4 font-semibold text-primary hover:bg-primary hover:text-white"
        >
          {t("switchLanguage")}
        </Link>
      </header>
      <section className="flex flex-1 flex-col justify-center gap-4 text-start">
        <h1 className="text-3xl font-bold leading-tight text-ink">
          {t("productName")}
        </h1>
        <p className="text-lg leading-relaxed text-muted">{t("tagline")}</p>
        <div className="flex flex-wrap gap-3">
          {signedIn ? (
            <>
              <Link href="/profile" className={primaryLink}>
                {t("myProfile")}
              </Link>
              <Link href="/account" className={secondaryLink}>
                {t("myAccount")}
              </Link>
            </>
          ) : (
            <>
              <Link href="/sign-up" className={primaryLink}>
                {t("signUp")}
              </Link>
              <Link href="/sign-in" className={secondaryLink}>
                {t("signIn")}
              </Link>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
