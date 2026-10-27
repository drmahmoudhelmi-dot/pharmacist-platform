import { useTranslations } from "next-intl";
import type { JobStatus } from "../constants";

const tone: Record<JobStatus, string> = {
  draft: "border-muted bg-canvas text-ink",
  pending_review: "border-amber-700 bg-amber-50 text-amber-900",
  published: "border-primary bg-teal-50 text-primary-strong",
  paused: "border-muted bg-canvas text-ink",
  closed: "border-muted bg-canvas text-muted",
  expired: "border-muted bg-canvas text-muted",
  rejected: "border-red-700 bg-red-50 text-red-800",
  removed: "border-red-700 bg-red-50 text-red-800",
};

/** The job's status as a word (never colour alone). */
export function StatusBadge({ status }: { status: JobStatus }) {
  const t = useTranslations("JobStatuses");
  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-1 text-sm font-semibold ${tone[status]}`}
      data-testid="job-status"
    >
      {t(status)}
    </span>
  );
}
