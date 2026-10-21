import { getTranslations, setRequestLocale } from "next-intl/server";
import { requireActor } from "@/modules/identity/policy";
import { getMyVerificationStatus } from "@/modules/verification/service";
import { VerificationStatusCard } from "@/modules/verification/ui/status-card";
import { VerificationForm } from "@/modules/verification/ui/verification-form";
import { getDb } from "@/shared/db/client";
import { isLocale } from "@/shared/i18n/routing";
import { PageShell, TextLink } from "@/shared/ui/page-shell";

type Props = { params: Promise<{ locale: string }> };

// The user's professional verification (ADR-004, 4b): current state, and the
// request form when a new submission is allowed (unverified, rejected, expired).
export default async function VerificationPage({ params }: Props) {
  const { locale } = await params;
  if (isLocale(locale)) setRequestLocale(locale);
  const actor = await requireActor();
  const status = await getMyVerificationStatus(getDb(), actor);
  const t = await getTranslations("Verification");
  const tc = await getTranslations("Common");

  return (
    <PageShell title={t("title")} homeLabel={tc("home")}>
      <p className="text-muted">{t("intro")}</p>
      {status ? (
        <>
          <VerificationStatusCard status={status} />
          {status.canSubmit ? (
            <section
              aria-labelledby="verification-form-heading"
              className="flex flex-col gap-3"
            >
              <h2
                id="verification-form-heading"
                className="text-lg font-semibold"
              >
                {status.state === "unverified"
                  ? t("formHeading")
                  : t("resubmitHeading")}
              </h2>
              <p className="text-muted">{t("privacyNote")}</p>
              <VerificationForm />
            </section>
          ) : null}
        </>
      ) : (
        <p
          role="alert"
          className="rounded-lg border border-red-700 bg-red-50 p-3 text-red-800"
        >
          {t("notAllowed")}
        </p>
      )}
      <TextLink href="/account">{t("accountLink")}</TextLink>
    </PageShell>
  );
}
