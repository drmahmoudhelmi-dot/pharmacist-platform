import { getTranslations } from "next-intl/server";
import { TextLink } from "@/shared/ui/page-shell";
import type { ApplyState } from "../applications";
import { ApplicationStatusBadge } from "./application-status-badge";
import { ApplyForm } from "./apply-form";

/**
 * The "Apply" part of the public job page, for whatever state the caller is
 * in. The service decides the state; the form's server action checks again.
 */
export async function ApplySection({
  jobId,
  state,
}: {
  jobId: string;
  state: ApplyState;
}) {
  const t = await getTranslations("Applications");
  return (
    <section
      aria-labelledby="apply-heading"
      className="flex flex-col gap-3 rounded-lg border border-muted bg-surface p-3"
      data-testid="apply-section"
      data-state={state.state}
    >
      <h2 id="apply-heading" className="text-lg font-semibold">
        {t("applyHeading")}
      </h2>
      {state.state === "signedOut" ? (
        <>
          <p>{t("signedOut")}</p>
          <TextLink href="/sign-in">{t("signInLink")}</TextLink>
        </>
      ) : null}
      {state.state === "noProfile" ? (
        <>
          <p>{t("noProfile")}</p>
          <TextLink href="/profile">{t("profileLink")}</TextLink>
        </>
      ) : null}
      {state.state === "ownOrganization" ? <p>{t("ownOrganization")}</p> : null}
      {state.state === "closed" ? <p>{t("closed")}</p> : null}
      {state.state === "applied" ? (
        <>
          <p>{t("alreadyApplied")}</p>
          <p>
            <ApplicationStatusBadge status={state.status} />
          </p>
          <TextLink href="/applications">{t("viewMyApplications")}</TextLink>
        </>
      ) : null}
      {state.state === "open" ? (
        <>
          <div
            className="flex flex-col gap-1 text-sm"
            data-testid="share-explainer"
          >
            <p className="font-semibold">{t("shareHeading")}</p>
            <ul className="ms-5 list-disc">
              <li>{t("shareProfile")}</li>
              <li>{t("sharePhoneRule")}</li>
              <li>{t("shareNever")}</li>
            </ul>
          </div>
          <ApplyForm jobId={jobId} canSharePhone={state.canSharePhone} />
        </>
      ) : null}
    </section>
  );
}
