import { getTranslations } from "next-intl/server";
import type { ReportState } from "../service";
import { ReportForm } from "./report-form";

/**
 * "Report this job" at the bottom of the public job page: a quiet disclosure
 * for members who may report, a confirmation once they have, nothing
 * otherwise. The service decides the state; the action checks again.
 */
export async function ReportSection({
  jobId,
  state,
}: {
  jobId: string;
  state: ReportState;
}) {
  if (state === "unavailable") return null;
  const t = await getTranslations("JobReport");
  if (state === "reported")
    return (
      <p
        role="status"
        className="rounded-lg border border-muted bg-surface p-3 text-sm"
        data-testid="report-confirmation"
      >
        {t("alreadyReported")}
      </p>
    );
  return (
    <details
      className="rounded-lg border border-muted p-3"
      data-testid="report-section"
    >
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-muted">
        {t("summary")}
      </summary>
      <div className="flex flex-col gap-3 pt-3">
        <p className="text-sm text-muted">{t("intro")}</p>
        <ReportForm jobId={jobId} />
      </div>
    </details>
  );
}
