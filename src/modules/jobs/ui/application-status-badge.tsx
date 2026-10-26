import { useTranslations } from "next-intl";
import type { ApplicationStatus } from "../constants";

const tone: Record<ApplicationStatus, string> = {
  submitted: "border-muted bg-canvas text-ink",
  under_review: "border-amber-700 bg-amber-50 text-amber-900",
  shortlisted: "border-primary bg-teal-50 text-primary-strong",
  accepted: "border-primary bg-primary text-white",
  rejected: "border-red-700 bg-red-50 text-red-800",
  withdrawn: "border-muted bg-canvas text-muted",
};

/** An application's status as a word (never colour alone). */
export function ApplicationStatusBadge({
  status,
}: {
  status: ApplicationStatus;
}) {
  const t = useTranslations("ApplicationStatuses");
  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-1 text-sm font-semibold ${tone[status]}`}
      data-testid="application-status"
    >
      {t(status)}
    </span>
  );
}
