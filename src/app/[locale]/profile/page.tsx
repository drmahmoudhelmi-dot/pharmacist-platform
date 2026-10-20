import { getTranslations, setRequestLocale } from "next-intl/server";
import { requireActor } from "@/modules/identity/policy";
import {
  getOwnProfessionalDetails,
  getOwnProfile,
  listGovernorates,
  listOwnExperience,
} from "@/modules/profiles/service";
import { ProfessionalDetailsForm } from "@/modules/profiles/ui/details-form";
import { ExperienceSection } from "@/modules/profiles/ui/experience-section";
import { ProfileForm } from "@/modules/profiles/ui/profile-form";
import { getDb } from "@/shared/db/client";
import { isLocale } from "@/shared/i18n/routing";
import { PageShell, TextLink } from "@/shared/ui/page-shell";

type Props = { params: Promise<{ locale: string }> };

// The owner's edit page. Reads go through the profiles services, which apply
// the policy with the session's Actor.
export default async function ProfilePage({ params }: Props) {
  const { locale } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireActor();
  const db = getDb();
  const [profile, details, experience, governorates] = await Promise.all([
    getOwnProfile(db, actor),
    getOwnProfessionalDetails(db, actor),
    listOwnExperience(db, actor),
    listGovernorates(db),
  ]);
  const t = await getTranslations("Profile");
  const tc = await getTranslations("Common");

  return (
    <PageShell title={t("title")} homeLabel={tc("home")}>
      <p className="text-muted">{t("intro")}</p>
      {profile ? (
        <div className="flex flex-col gap-1">
          <p>
            {t("visibilityStateLabel")}:{" "}
            <span
              className="rounded bg-canvas px-2 py-1 font-semibold"
              data-testid="visibility-state"
            >
              {t(`visibilityState.${profile.visibility}`)}
            </span>
          </p>
          <TextLink href={`/profiles/${profile.id}`}>
            {t("viewPublic")}
          </TextLink>
        </div>
      ) : (
        <p
          className="rounded-lg border border-muted bg-surface p-3"
          data-testid="profile-empty"
        >
          {t("empty")}
        </p>
      )}
      <section
        aria-labelledby="profile-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="profile-heading" className="text-lg font-semibold">
          {t("profileHeading")}
        </h2>
        <p className="text-muted">{t("profileExplain")}</p>
        <ProfileForm profile={profile} governorates={governorates} />
      </section>
      <section
        aria-labelledby="details-heading"
        className="flex flex-col gap-3 rounded-lg border-2 border-dashed border-muted p-3"
      >
        <h2 id="details-heading" className="text-lg font-semibold">
          {t("detailsHeading")}{" "}
          <span className="rounded bg-ink px-2 py-1 text-sm text-white">
            {t("privateBadge")}
          </span>
        </h2>
        <p className="text-muted">{t("detailsExplain")}</p>
        <ProfessionalDetailsForm details={details} />
      </section>
      <section
        aria-labelledby="experience-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="experience-heading" className="text-lg font-semibold">
          {t("experienceHeading")}
        </h2>
        <p className="text-muted">{t("experienceExplain")}</p>
        <ExperienceSection items={experience} />
      </section>
      <TextLink href="/account">{t("accountLink")}</TextLink>
    </PageShell>
  );
}
