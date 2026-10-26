import { getLocale, getTranslations } from "next-intl/server";
import { formatMonth } from "@/modules/profiles/ui/format";
import { VerifiedBadge } from "@/modules/profiles/ui/profile-view";
import type { ApplicationSnapshot } from "../application-snapshot";

/**
 * What the applicant shared, as the employer sees it: the profile fields
 * copied at apply time (never the live profile), the phone only when the
 * applicant ticked it, and the cover note. No email is ever shown.
 */
export async function ApplicantSnapshot({
  profile,
  phoneE164,
  coverNote,
  verified,
}: {
  profile: ApplicationSnapshot;
  phoneE164: string | null;
  coverNote: string | null;
  verified: boolean;
}) {
  const t = await getTranslations("ProfileView");
  const tp = await getTranslations("Profile");
  const ta = await getTranslations("Applications");
  const locale = await getLocale();
  const governorate = profile.governorate
    ? locale === "ar"
      ? profile.governorate.nameAr
      : profile.governorate.nameEn
    : null;

  return (
    <article className="flex flex-col gap-5" data-testid="applicant-snapshot">
      <header className="flex flex-col gap-2">
        <h2 className="text-xl font-bold" data-testid="applicant-name">
          <bdi>{profile.displayName}</bdi>
        </h2>
        {verified ? <VerifiedBadge label={t("verifiedBadge")} /> : null}
        {profile.headline ? (
          <p className="text-lg">
            <bdi>{profile.headline}</bdi>
          </p>
        ) : null}
        <ul className="flex flex-wrap gap-2 text-sm">
          <li className="rounded bg-canvas px-2 py-1 font-semibold">
            {tp(`careerStages.${profile.careerStage}`)}
          </li>
          <li className="rounded bg-canvas px-2 py-1">
            {t("yearsExperience", { count: profile.yearsExperience })}
          </li>
          {governorate ? (
            <li className="rounded bg-canvas px-2 py-1">{governorate}</li>
          ) : null}
        </ul>
      </header>
      <section
        aria-labelledby="contact-heading"
        className="flex flex-col gap-1"
      >
        <h3 id="contact-heading" className="text-lg font-semibold">
          {ta("contactHeading")}
        </h3>
        {phoneE164 ? (
          <p>
            <a
              href={`tel:${phoneE164}`}
              dir="ltr"
              className="inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-4"
              data-testid="applicant-phone"
            >
              {phoneE164}
            </a>
          </p>
        ) : (
          <p className="text-muted" data-testid="applicant-no-phone">
            {ta("noPhoneShared")}
          </p>
        )}
      </section>
      <section aria-labelledby="note-heading" className="flex flex-col gap-1">
        <h3 id="note-heading" className="text-lg font-semibold">
          {ta("coverNoteHeading")}
        </h3>
        {coverNote ? (
          <p
            dir="auto"
            className="whitespace-pre-line text-start"
            data-testid="applicant-note"
          >
            {coverNote}
          </p>
        ) : (
          <p className="text-muted">{ta("noCoverNote")}</p>
        )}
      </section>
      {profile.bio ? (
        <section aria-labelledby="bio-heading" className="flex flex-col gap-2">
          <h3 id="bio-heading" className="text-lg font-semibold">
            {t("bioHeading")}
          </h3>
          <p dir="auto" className="whitespace-pre-line text-start">
            {profile.bio}
          </p>
        </section>
      ) : null}
      {profile.specialties.length > 0 ? (
        <section
          aria-labelledby="specialties-heading"
          className="flex flex-col gap-2"
        >
          <h3 id="specialties-heading" className="text-lg font-semibold">
            {t("specialtiesHeading")}
          </h3>
          <ul className="flex flex-wrap gap-2">
            {profile.specialties.map((s) => (
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
        {profile.experience.length === 0 ? (
          <p className="text-muted">{t("noExperience")}</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {profile.experience.map((e, i) => (
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
