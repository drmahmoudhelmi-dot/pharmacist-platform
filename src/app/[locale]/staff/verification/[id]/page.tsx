import { getLocale, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { requireStaff } from "@/modules/identity/policy";
import { getSubmissionForReview } from "@/modules/verification/service";
import {
  DecisionForm,
  RevealNationalId,
} from "@/modules/verification/ui/review-controls";
import { getDb } from "@/shared/db/client";
import { isLocale } from "@/shared/i18n/routing";
import { PageShell, TextLink } from "@/shared/ui/page-shell";

type Props = { params: Promise<{ locale: string; id: string }> };

export const dynamicParams = true;

/**
 * One submission for review. The legal name in Arabic the user typed from the
 * national ID card, shown above the claims and kept in view beside the photos
 * for comparison. Masked national ID until the reviewer reveals it (logged). Photos load through /api/verification/documents/<id>, which logs
 * each view and redirects to a 5-minute signed URL; they are shown only while
 * the submission is pending. Own, missing and malformed ids all answer 404.
 */
export default async function ReviewSubmissionPage({ params }: Props) {
  const { locale, id } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireStaff("verification_reviewer");
  const submission = await getSubmissionForReview(getDb(), actor, id);
  if (!submission) notFound();
  const t = await getTranslations("StaffVerification");
  const tv = await getTranslations("Verification");
  const tr = await getTranslations("VerificationReasons");
  const tc = await getTranslations("Common");
  const format = new Intl.DateTimeFormat(
    (await getLocale()) === "ar" ? "ar-EG" : "en-GB",
    { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" },
  );
  const pending = submission.status === "pending";

  return (
    <PageShell title={t("detailTitle")} homeLabel={tc("home")}>
      <section
        className="flex flex-col gap-2 rounded-lg border border-muted bg-surface p-3"
        aria-labelledby="claims-heading"
      >
        <h2 id="claims-heading" className="text-lg font-semibold">
          {t("claimsHeading")}
        </h2>
        <p>
          {t("statusLabel")}:{" "}
          <span className="font-semibold" data-testid="review-status">
            {tv(`states.${submission.status}`)}
          </span>
        </p>
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted">{t("legalNameLabel")}</p>
          <p className="text-xl font-bold">
            <bdi dir="rtl" lang="ar" data-testid="review-legal-name">
              {submission.legalNameAr}
            </bdi>
          </p>
        </div>
        <p>
          {tv("credentialTypeLabel")}:{" "}
          {tv(`credentialTypes.${submission.credentialType}`)}
        </p>
        {submission.syndicateNumber ? (
          <p>
            {tv("syndicateNumberLabel")}:{" "}
            <bdi dir="ltr">{submission.syndicateNumber}</bdi>
          </p>
        ) : null}
        {submission.university ? (
          <p>
            {tv("universityLabel")}: <bdi>{submission.university}</bdi>
          </p>
        ) : null}
        <p>
          {tv("cardExpiresOnLabel")}:{" "}
          {submission.cardExpiresOn ? (
            <bdi dir="ltr">{submission.cardExpiresOn}</bdi>
          ) : (
            t("noExpiry")
          )}
        </p>
        <p className="text-sm text-muted">
          {t("submittedAt", { date: format.format(submission.submittedAt) })}
        </p>
        {pending ? (
          <RevealNationalId
            submissionId={submission.id}
            masked={submission.nationalIdMasked}
          />
        ) : (
          <p>
            {t("nationalIdLabel")}:{" "}
            <bdi dir="ltr" className="font-mono">
              {submission.nationalIdMasked}
            </bdi>
          </p>
        )}
      </section>
      {pending ? (
        <section
          className="flex flex-col gap-3"
          aria-labelledby="documents-heading"
        >
          <h2 id="documents-heading" className="text-lg font-semibold">
            {t("documentsHeading")}
          </h2>
          <p className="text-sm text-muted">{t("documentsExplain")}</p>
          {/* The name stays in view while the reviewer scrolls the photos. */}
          <div
            className="sticky top-0 z-10 flex flex-col gap-1 rounded-lg border-2 border-primary bg-surface p-3"
            data-testid="review-legal-name-compare"
          >
            <p className="text-sm text-muted">{t("legalNameCompare")}</p>
            <p className="text-xl font-bold">
              <bdi dir="rtl" lang="ar">
                {submission.legalNameAr}
              </bdi>
            </p>
          </div>
          <ul className="flex flex-col gap-4">
            {submission.documents.map((doc) => (
              <li key={doc.id} className="flex flex-col gap-2">
                <span className="font-semibold">
                  {tv(`documentKinds.${doc.kind}`)}
                </span>
                {/* A plain <img>: the source is a logged, no-store redirect to a
                    short-lived signed URL, which must not be optimized, cached
                    or proxied, and must not leak this page in a Referer. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/verification/documents/${doc.id}`}
                  alt={tv(`documentKinds.${doc.kind}`)}
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  className="w-full rounded-lg border border-muted bg-canvas"
                  data-testid={`review-document-${doc.kind}`}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section
        className="flex flex-col gap-3"
        aria-labelledby="decision-heading"
      >
        <h2 id="decision-heading" className="text-lg font-semibold">
          {t("decisionHeading")}
        </h2>
        {submission.decision ? (
          <div
            role="status"
            className="flex flex-col gap-1 rounded-lg border border-muted bg-surface p-3"
            data-testid="decision-summary"
          >
            <p className="font-semibold">
              {t(`decisions.${submission.decision.decision}`)}
            </p>
            <p>
              {t("reasonLabel")}: {tr(submission.decision.reasonCode)}
            </p>
            {submission.decision.note ? (
              <p dir="auto" className="whitespace-pre-line text-start">
                {submission.decision.note}
              </p>
            ) : null}
            <p className="text-sm text-muted">
              {format.format(submission.decision.decidedAt)}
              {submission.decision.byMe ? ` · ${t("byYou")}` : ""}
            </p>
          </div>
        ) : pending ? (
          <DecisionForm submissionId={submission.id} />
        ) : null}
      </section>
      <TextLink href="/staff/verification">{t("queueLink")}</TextLink>
    </PageShell>
  );
}
