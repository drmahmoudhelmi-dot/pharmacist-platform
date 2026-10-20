import { useLocale, useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { use } from "react";
import { Link } from "@/shared/i18n/navigation";
import { isLocale } from "@/shared/i18n/routing";

type Props = { params: Promise<{ locale: string }> };

export default function HomePage({ params }: Props) {
  const { locale: routeLocale } = use(params);
  if (isLocale(routeLocale)) setRequestLocale(routeLocale);

  const t = useTranslations("Home");
  const locale = useLocale();
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
      </section>
    </main>
  );
}
