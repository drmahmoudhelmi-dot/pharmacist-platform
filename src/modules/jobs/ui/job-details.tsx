import { getTranslations } from "next-intl/server";
import type { JobContent, OrganizationRef } from "../service";
import { NotReviewedNote } from "./not-reviewed-note";
import { formatCalendarDate, formatCount, formatPounds } from "./format";

/** One line for the pay: a range, a lower or upper bound, or "not stated". */
export async function salaryText(
  job: Pick<JobContent, "salaryMinPounds" | "salaryMaxPounds">,
  locale: string,
): Promise<string> {
  const t = await getTranslations("Jobs");
  const { salaryMinPounds: min, salaryMaxPounds: max } = job;
  if (min !== null && max !== null)
    return t("salaryRange", {
      min: formatPounds(min, locale),
      max: formatPounds(max, locale),
    });
  if (min !== null) return t("salaryFrom", { min: formatPounds(min, locale) });
  if (max !== null) return t("salaryUpTo", { max: formatPounds(max, locale) });
  return t("salaryNone");
}

/**
 * The job's content as readers see it. Shared by the public page, the
 * moderator's review page and the employer's read-only view.
 */
export async function JobDetails({
  job,
  organization,
  locale,
  posterVerified,
  publishedLabel,
}: {
  job: JobContent;
  organization: OrganizationRef;
  locale: string;
  posterVerified?: boolean;
  /** Formatted publication date, when there is one to show. */
  publishedLabel?: string;
}) {
  const t = await getTranslations("Jobs");
  const tc = await getTranslations("JobCategories");
  const tt = await getTranslations("EmploymentTypes");
  const tk = await getTranslations("OrganizationKinds");
  const governorate = job.governorate
    ? locale === "en"
      ? job.governorate.nameEn
      : job.governorate.nameAr
    : null;
  return (
    <div className="flex flex-col gap-4">
      <section
        aria-labelledby="job-details-heading"
        className="flex flex-col gap-2 rounded-lg border border-muted bg-surface p-3"
      >
        <h2 id="job-details-heading" className="text-lg font-semibold">
          {t("detailsHeading")}
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="font-semibold">{t("organizationLabel")}</dt>
          <dd data-testid="job-organization">
            <bdi>{organization.name}</bdi>{" "}
            <span className="text-sm text-muted">
              ({tk(organization.kind)})
            </span>
          </dd>
          <dt className="font-semibold">{t("locationLabel")}</dt>
          <dd>
            {governorate ?? "—"}
            {job.area ? (
              <>
                {" · "}
                <bdi>{job.area}</bdi>
              </>
            ) : null}
          </dd>
          <dt className="font-semibold">{t("categoryLabelShort")}</dt>
          <dd>{tc(job.category)}</dd>
          <dt className="font-semibold">{t("employmentTypeLabel")}</dt>
          <dd>{tt(job.employmentType)}</dd>
          {job.startDate && job.endDate ? (
            <>
              <dt className="font-semibold">{t("periodLabel")}</dt>
              <dd>
                {t("period", {
                  start: formatCalendarDate(job.startDate, locale),
                  end: formatCalendarDate(job.endDate, locale),
                })}
              </dd>
            </>
          ) : null}
          <dt className="font-semibold">{t("experienceLabel")}</dt>
          <dd>{formatCount(job.minYearsExperience, locale)}</dd>
          <dt className="font-semibold">{t("stagesLabel")}</dt>
          <dd>
            {new Intl.ListFormat(locale, { type: "conjunction" }).format(
              job.careerStages.map((s) => t(`careerStages.${s}`)),
            )}
          </dd>
          <dt className="font-semibold">{t("salaryLabel")}</dt>
          <dd data-testid="job-salary">{await salaryText(job, locale)}</dd>
          {publishedLabel ? (
            <>
              <dt className="font-semibold">{t("publishedLabel")}</dt>
              <dd>{publishedLabel}</dd>
            </>
          ) : null}
        </dl>
        {posterVerified ? (
          <p>
            <span
              className="inline-flex rounded border border-primary bg-teal-50 px-2 py-1 text-sm font-semibold text-primary-strong"
              data-testid="verified-poster"
            >
              {t("verifiedPoster")}
            </span>
          </p>
        ) : null}
        <NotReviewedNote>{t("notReviewed")}</NotReviewedNote>
      </section>
      <section
        aria-labelledby="job-description-heading"
        className="flex flex-col gap-2"
      >
        <h2 id="job-description-heading" className="text-lg font-semibold">
          {t("descriptionHeading")}
        </h2>
        <p
          dir="auto"
          className="whitespace-pre-line text-start leading-relaxed"
          data-testid="job-description"
        >
          {job.description}
        </p>
      </section>
    </div>
  );
}
