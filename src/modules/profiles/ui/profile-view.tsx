import { getLocale, getTranslations } from "next-intl/server";
import { Link } from "@/shared/i18n/navigation";
import type { ProfileView as View } from "../service";
import { formatMonth } from "./format";

/**
 * Shown only when the verification module reports the owner as verified.
 * The check mark is not mirrored in RTL.
 */
export function VerifiedBadge({ label }: { label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-primary px-2 py-1 text-sm font-semibold text-white"
      data-testid="verified-badge"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        className="size-4 fill-current"
      >
        <path d="M8.2 13.6 4.6 10l-1.2 1.2 4.8 4.8 9-9-1.2-1.2z" />
      </svg>
      {label}
    </span>
  );
}

/** A profile as members see it. Receives only public fields (see the service). */
export async function ProfileView({ view }: { view: View }) {
  const t = await getTranslations("ProfileView");
  const tp = await getTranslations("Profile");
  const locale = await getLocale();
  const governorate = view.governorate
    ? locale === "ar"
      ? view.governorate.nameAr
      : view.governorate.nameEn
    : null;

  return (
    <article className="flex flex-col gap-5" data-testid="profile-view">
      {view.isOwner ? (
        <div
          role="status"
          className={`flex flex-col gap-2 rounded-lg border p-3 ${
            view.hidden
              ? "border-red-700 bg-red-50 text-red-800"
              : "border-primary bg-teal-50 text-primary-strong"
          }`}
        >
          <p>{view.hidden ? t("hiddenNotice") : t("ownerNotice")}</p>
          <Link
            href="/profile"
            className="inline-flex min-h-11 items-center font-semibold underline underline-offset-4"
          >
            {t("editLink")}
          </Link>
        </div>
      ) : null}
      <header className="flex flex-col gap-2">
        <h2 className="text-xl font-bold" data-testid="profile-name">
          <bdi>{view.displayName}</bdi>
        </h2>
        {view.verified ? <VerifiedBadge label={t("verifiedBadge")} /> : null}
        {view.headline ? (
          <p className="text-lg">
            <bdi>{view.headline}</bdi>
          </p>
        ) : null}
        <ul className="flex flex-wrap gap-2 text-sm">
          <li className="rounded bg-canvas px-2 py-1 font-semibold">
            {tp(`careerStages.${view.careerStage}`)}
          </li>
          <li className="rounded bg-canvas px-2 py-1">
            {t("yearsExperience", { count: view.yearsExperience })}
          </li>
          {governorate ? (
            <li className="rounded bg-canvas px-2 py-1">{governorate}</li>
          ) : null}
          {view.openToWork ? (
            <li className="rounded bg-teal-50 px-2 py-1 font-semibold text-primary-strong">
              {t("openToWork")}
            </li>
          ) : null}
        </ul>
      </header>
      {view.bio ? (
        <section aria-labelledby="bio-heading" className="flex flex-col gap-2">
          <h3 id="bio-heading" className="text-lg font-semibold">
            {t("bioHeading")}
          </h3>
          <p dir="auto" className="whitespace-pre-line text-start">
            {view.bio}
          </p>
        </section>
      ) : null}
      {view.specialties.length > 0 ? (
        <section
          aria-labelledby="specialties-heading"
          className="flex flex-col gap-2"
        >
          <h3 id="specialties-heading" className="text-lg font-semibold">
            {t("specialtiesHeading")}
          </h3>
          <ul className="flex flex-wrap gap-2">
            {view.specialties.map((s) => (
              <li key={s} className="rounded border border-muted px-2 py-1">
                {tp(`specialties.${s}`)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section
        aria-labelledby="experience-heading"
        className="flex flex-col gap-2"
      >
        <h3 id="experience-heading" className="text-lg font-semibold">
          {t("experienceHeading")}
        </h3>
        {view.experience.length === 0 ? (
          <p className="text-muted">{t("noExperience")}</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {view.experience.map((e, i) => (
              <li key={i} className="flex flex-col gap-1">
                <span className="font-semibold">
                  <bdi>{e.title}</bdi>
                </span>
                <span>
                  <bdi>{e.employerName}</bdi>
                </span>
                <span className="text-sm text-muted">
                  {formatMonth(locale, e.startMonth)} –{" "}
                  {e.endMonth ? formatMonth(locale, e.endMonth) : t("present")}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </article>
  );
}
