import { getLocale, getTranslations } from "next-intl/server";
import type { MyVerification } from "../service";

const TONES = {
  unverified: "border-muted bg-surface text-ink",
  pending: "border-amber-700 bg-amber-50 text-amber-900",
  verified: "border-primary bg-teal-50 text-primary-strong",
  rejected: "border-red-700 bg-red-50 text-red-800",
  expired: "border-red-700 bg-red-50 text-red-800",
} as const;

function formatDate(locale: string, value: Date | string | null) {
  if (!value) return null;
  const date =
    typeof value === "string" ? new Date(`${value}T12:00:00Z`) : value;
  return new Intl.DateTimeFormat(locale === "ar" ? "ar-EG" : "en-GB", {
    dateStyle: "long",
    timeZone: "Africa/Cairo",
  }).format(date);
}

/** The user's verification state, always visible and clearly worded. */
export async function VerificationStatusCard({
  status,
}: {
  status: MyVerification;
}) {
  const t = await getTranslations("Verification");
  const tr = await getTranslations("VerificationReasons");
  const locale = await getLocale();
  return (
    <section
      role="status"
      aria-labelledby="verification-state-heading"
      className={`flex flex-col gap-2 rounded-lg border p-3 ${TONES[status.state]}`}
      data-testid="verification-status"
      data-state={status.state}
    >
      <h2 id="verification-state-heading" className="text-lg font-semibold">
        {t("stateLabel")}:{" "}
        <span data-testid="verification-state">
          {t(`states.${status.state}`)}
        </span>
      </h2>
      <p>{t(`stateExplain.${status.state}`)}</p>
      {status.credentialType ? (
        <p>
          {t("credentialTypeLabel")}:{" "}
          {t(`credentialTypes.${status.credentialType}`)}
        </p>
      ) : null}
      {status.nationalIdMasked ? (
        <p>
          {t("nationalIdLabel")}:{" "}
          <bdi dir="ltr" data-testid="national-id-masked">
            {status.nationalIdMasked}
          </bdi>
        </p>
      ) : null}
      {status.submittedAt ? (
        <p className="text-sm">
          {t("submittedOn", {
            date: formatDate(locale, status.submittedAt) ?? "",
          })}
        </p>
      ) : null}
      {status.state === "verified" && status.cardExpiresOn ? (
        <p className="text-sm">
          {t("validUntil", {
            date: formatDate(locale, status.cardExpiresOn) ?? "",
          })}
        </p>
      ) : null}
      {status.state === "rejected" && status.rejectionReason ? (
        <p className="font-semibold" data-testid="rejection-reason">
          {t("reasonLabel")}: {tr(status.rejectionReason)}
        </p>
      ) : null}
    </section>
  );
}
