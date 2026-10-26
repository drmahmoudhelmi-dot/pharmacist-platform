import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { searchJobs } from "@/modules/jobs/service";
import { EMPLOYMENT_TYPES, JOB_CATEGORIES } from "@/modules/jobs/constants";
import { dateTimeFormat } from "@/modules/jobs/ui/format";
import { salaryText } from "@/modules/jobs/ui/job-details";
import { parseSearch } from "@/modules/jobs/validation";
import { listGovernorates } from "@/modules/profiles/governorates";
import { getDb } from "@/shared/db/client";
import { Link } from "@/shared/i18n/navigation";
import { isLocale } from "@/shared/i18n/routing";
import { SelectField, TextField } from "@/shared/ui/form";
import { PageShell } from "@/shared/ui/page-shell";

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// The public job board (ADR-006). No sign-in; filters come from the URL.
export default async function JobsPage({ params, searchParams }: Props) {
  const { locale: routeLocale } = await params;
  const locale = isLocale(routeLocale) ? routeLocale : "ar";
  setRequestLocale(locale);
  const raw = await searchParams;
  const first: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw))
    first[key] = Array.isArray(value) ? value[0] : value;
  const query = parseSearch(first);
  const db = getDb();
  const [page, governorates] = await Promise.all([
    searchJobs(db, first),
    listGovernorates(db),
  ]);
  const t = await getTranslations("Jobs");
  const tc = await getTranslations("JobCategories");
  const tt = await getTranslations("EmploymentTypes");
  const tk = await getTranslations("OrganizationKinds");
  const tcm = await getTranslations("Common");
  const format = dateTimeFormat(await getLocale());

  const filters = new URLSearchParams();
  if (query.q) filters.set("q", query.q);
  if (query.governorateId !== null)
    filters.set("governorate", String(query.governorateId));
  if (query.category) filters.set("category", query.category);
  if (query.employmentType) filters.set("type", query.employmentType);
  const filtered = filters.size > 0;
  const next = new URLSearchParams(filters);
  if (page.nextCursor) next.set("cursor", page.nextCursor);

  return (
    <PageShell title={t("boardTitle")} homeLabel={tcm("home")}>
      <p className="text-muted">{t("boardIntro")}</p>
      <form
        method="get"
        action={locale === "en" ? "/en/jobs" : "/jobs"}
        className="flex flex-col gap-3 rounded-lg border border-muted bg-surface p-3"
        role="search"
        data-testid="job-search"
      >
        <TextField
          name="q"
          label={t("searchLabel")}
          hint={t("searchHint")}
          dir="auto"
          required={false}
          maxLength={80}
          defaultValue={query.q}
        />
        <SelectField
          name="governorate"
          label={t("governorateFilter")}
          placeholder={t("allGovernorates")}
          required={false}
          options={governorates.map((g) => ({
            value: String(g.id),
            label: locale === "ar" ? g.nameAr : g.nameEn,
          }))}
          defaultValue={
            query.governorateId !== null
              ? String(query.governorateId)
              : undefined
          }
        />
        <SelectField
          name="category"
          label={t("categoryFilter")}
          placeholder={t("allCategories")}
          required={false}
          options={JOB_CATEGORIES.map((value) => ({
            value,
            label: tc(value),
          }))}
          defaultValue={query.category ?? undefined}
        />
        <SelectField
          name="type"
          label={t("typeFilter")}
          placeholder={t("allTypes")}
          required={false}
          options={EMPLOYMENT_TYPES.map((value) => ({
            value,
            label: tt(value),
          }))}
          defaultValue={query.employmentType ?? undefined}
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-5 font-semibold text-white hover:bg-primary-strong"
          >
            {t("searchButton")}
          </button>
          {filtered ? (
            <Link
              href="/jobs"
              className="inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-4"
            >
              {t("resetFilters")}
            </Link>
          ) : null}
        </div>
      </form>
      <p className="text-sm text-muted">{t("notReviewed")}</p>
      {page.items.length === 0 ? (
        <p
          className="rounded-lg border border-muted bg-surface p-3"
          data-testid="jobs-empty"
        >
          {t("resultsEmpty")}
        </p>
      ) : (
        <ul
          className="flex flex-col gap-3"
          aria-label={t("resultsLabel")}
          data-testid="job-results"
        >
          {await Promise.all(
            page.items.map(async (job) => (
              <li key={job.id}>
                <Link
                  href={`/jobs/${job.id}`}
                  className="flex min-h-11 flex-col gap-1 rounded-lg border border-muted bg-surface p-3 hover:border-primary"
                  data-testid="job-card"
                >
                  <bdi className="text-lg font-semibold text-primary">
                    {job.title}
                  </bdi>
                  <span>
                    <bdi>{job.organization.name}</bdi>{" "}
                    <span className="text-sm text-muted">
                      ({tk(job.organization.kind)})
                    </span>
                  </span>
                  <span className="text-sm text-muted">
                    {job.governorate
                      ? locale === "en"
                        ? job.governorate.nameEn
                        : job.governorate.nameAr
                      : ""}{" "}
                    · {tc(job.category)} · {tt(job.employmentType)}
                  </span>
                  <span className="text-sm">
                    {await salaryText(job, locale)}
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    {job.posterVerified ? (
                      <span
                        className="inline-flex rounded border border-primary bg-teal-50 px-2 py-1 text-sm font-semibold text-primary-strong"
                        data-testid="verified-poster"
                      >
                        {t("verifiedPoster")}
                      </span>
                    ) : null}
                    <span className="text-sm text-muted">
                      {t("publishedOn", {
                        date: format.format(new Date(job.publishedAt)),
                      })}
                    </span>
                  </span>
                </Link>
              </li>
            )),
          )}
        </ul>
      )}
      {page.nextCursor ? (
        <nav aria-label={t("pagination")}>
          <Link
            href={`/jobs?${next.toString()}`}
            className="inline-flex min-h-11 items-center font-semibold text-primary underline underline-offset-4"
            data-testid="jobs-next"
          >
            {t("nextPage")}
          </Link>
        </nav>
      ) : null}
    </PageShell>
  );
}
