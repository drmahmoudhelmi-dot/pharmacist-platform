import { getTranslations, setRequestLocale } from "next-intl/server";
import { getActor } from "@/modules/identity/policy";
import { Link } from "@/shared/i18n/navigation";
import { isLocale } from "@/shared/i18n/routing";
import { Icon, type IconName } from "@/shared/ui/icons";

type Props = { params: Promise<{ locale: string }> };

const onDark =
  "inline-flex min-h-11 items-center justify-center rounded-lg border-2 border-white px-5 font-semibold text-white hover:bg-white hover:text-primary-strong focus-visible:outline-white";
const onDarkPrimary =
  "inline-flex min-h-11 items-center justify-center rounded-lg border-2 border-white bg-white px-5 font-semibold text-primary-strong hover:bg-teal-50 focus-visible:outline-white";

const FEATURES = {
  pharmacists: [
    { key: "profile", icon: "badge" },
    { key: "jobs", icon: "search" },
    { key: "privacy", icon: "lock" },
  ],
  pharmacies: [
    { key: "organization", icon: "building" },
    { key: "recruiters", icon: "users" },
    { key: "post", icon: "briefcase" },
    { key: "review", icon: "inbox" },
  ],
  trust: [
    { key: "verification", icon: "badge" },
    { key: "moderation", icon: "eye" },
    { key: "reports", icon: "flag" },
  ],
} as const satisfies Record<string, readonly { key: string; icon: IconName }[]>;

const STEPS = ["account", "setup", "start"] as const;

export default async function HomePage({ params }: Props) {
  const { locale: routeLocale } = await params;
  const locale = isLocale(routeLocale) ? routeLocale : "ar";
  setRequestLocale(locale);

  const t = await getTranslations("Home");
  // Only decides which links to show; every page checks access itself.
  const signedIn = (await getActor()) !== null;
  const otherLocale = locale === "ar" ? "en" : "ar";
  const numbers = new Intl.NumberFormat(locale === "ar" ? "ar-EG" : "en-GB");

  const groups = [
    { id: "pharmacists", features: FEATURES.pharmacists },
    { id: "pharmacies", features: FEATURES.pharmacies },
    { id: "trust", features: FEATURES.trust },
  ] as const;

  return (
    <main className="flex min-h-dvh flex-col">
      <section className="bg-primary-strong text-white">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-4 py-6 md:py-10">
          <header className="flex justify-end">
            <Link
              href="/"
              locale={otherLocale}
              lang={otherLocale}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border-2 border-white px-4 font-semibold text-white hover:bg-white hover:text-primary-strong focus-visible:outline-white"
            >
              {t("switchLanguage")}
            </Link>
          </header>
          <div className="flex max-w-2xl flex-col gap-4 text-start">
            <h1 className="text-4xl font-bold leading-tight">
              {t("productName")}
            </h1>
            <p className="text-xl leading-relaxed">{t("tagline")}</p>
            <p className="leading-relaxed text-teal-50">{t("heroNote")}</p>
            <div className="flex flex-wrap gap-3 pt-2">
              <Link href="/jobs" className={onDarkPrimary}>
                {t("jobs")}
              </Link>
              {signedIn ? (
                <>
                  <Link href="/profile" className={onDark}>
                    {t("myProfile")}
                  </Link>
                  <Link href="/applications" className={onDark}>
                    {t("myApplications")}
                  </Link>
                  <Link href="/organizations" className={onDark}>
                    {t("myOrganizations")}
                  </Link>
                  <Link href="/account" className={onDark}>
                    {t("myAccount")}
                  </Link>
                </>
              ) : (
                <>
                  <Link href="/sign-up" className={onDark}>
                    {t("signUp")}
                  </Link>
                  <Link href="/sign-in" className={onDark}>
                    {t("signIn")}
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="mx-auto flex w-full max-w-5xl flex-col gap-12 px-4 py-10">
        {groups.map((group) => (
          <section
            key={group.id}
            aria-labelledby={`${group.id}-heading`}
            className="flex flex-col gap-4"
            data-testid={`home-${group.id}`}
          >
            <div className="flex flex-col gap-1">
              <h2
                id={`${group.id}-heading`}
                className="text-2xl font-bold text-ink"
              >
                {t(`${group.id}.title`)}
              </h2>
              <p className="text-muted">{t(`${group.id}.intro`)}</p>
            </div>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.features.map((feature) => (
                <li
                  key={feature.key}
                  className="flex flex-col gap-2 rounded-lg border border-muted bg-surface p-4"
                >
                  <span className="flex size-10 items-center justify-center rounded-full bg-teal-50 text-primary-strong">
                    <Icon name={feature.icon} />
                  </span>
                  <h3 className="text-lg font-semibold text-ink">
                    {t(`${group.id}.items.${feature.key}.title`)}
                  </h3>
                  <p className="leading-relaxed text-muted">
                    {t(`${group.id}.items.${feature.key}.text`)}
                  </p>
                </li>
              ))}
            </ul>
            {group.id === "trust" ? (
              <p className="flex items-start gap-3 rounded-lg border-2 border-amber-700 bg-amber-50 p-3 text-amber-950">
                <Icon name="info" className="mt-0.5 size-6 shrink-0" />
                <span className="leading-relaxed">{t("trust.note")}</span>
              </p>
            ) : null}
          </section>
        ))}

        <section aria-labelledby="how-heading" className="flex flex-col gap-4">
          <h2 id="how-heading" className="text-2xl font-bold text-ink">
            {t("how.title")}
          </h2>
          <ol className="grid gap-3 md:grid-cols-3">
            {STEPS.map((step, index) => (
              <li
                key={step}
                className="flex items-start gap-3 rounded-lg border border-muted bg-surface p-4"
              >
                <span
                  aria-hidden="true"
                  className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-lg font-bold text-white"
                >
                  {numbers.format(index + 1)}
                </span>
                <div className="flex flex-col gap-1">
                  <h3 className="text-lg font-semibold text-ink">
                    {t(`how.steps.${step}.title`)}
                  </h3>
                  <p className="leading-relaxed text-muted">
                    {t(`how.steps.${step}.text`)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}
