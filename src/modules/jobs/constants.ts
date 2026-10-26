// Allowed values and limits for jobs (ADR-006). Kept free of imports beyond
// other pure constants so the schema, policy, validation and client components
// can share them.

export { CAREER_STAGES, type CareerStage } from "@/modules/profiles/constants";

export const JOB_STATUSES = [
  "draft",
  "pending_review",
  "published",
  "paused",
  "closed",
  "expired",
  "rejected",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_CATEGORIES = [
  "pharmacist",
  "pharmacy_manager",
  "area_manager",
  "trainee",
  "other",
] as const;
export type JobCategory = (typeof JOB_CATEGORIES)[number];

export const EMPLOYMENT_TYPES = [
  "full_time",
  "part_time",
  "temporary",
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const MODERATION_DECISIONS = ["approved", "rejected"] as const;
export type ModerationDecision = (typeof MODERATION_DECISIONS)[number];

export const APPROVE_REASONS = ["meets_guidelines"] as const;
export const REJECT_REASONS = [
  "incomplete",
  "misleading_or_fraud",
  "not_pharmacy_related",
  "contact_details_in_text",
  "discriminatory",
  "other",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];
export const REASON_CODES = [...APPROVE_REASONS, ...REJECT_REASONS] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const NOTIFICATION_KINDS = ["approved", "rejected", "expired"] as const;
export type JobNotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const EMAIL_LOCALES = ["ar", "en"] as const;
export type EmailLocale = (typeof EMAIL_LOCALES)[number];

/**
 * Allowed transitions (ADR-006). The service has one function per action and
 * the database trigger in migration 0008 enforces the same table.
 */
export const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  draft: ["pending_review", "published"],
  // A rejected job always goes back to review.
  rejected: ["pending_review"],
  pending_review: ["published", "rejected"],
  published: ["paused", "closed", "expired"],
  paused: ["published", "closed", "expired"],
  closed: [],
  expired: [],
};

/** Statuses whose content may be edited (and that may be deleted). */
export const EDITABLE: readonly JobStatus[] = ["draft", "rejected"];

export const LIMITS = {
  title: { min: 4, max: 120 },
  area: { max: 120 },
  description: { min: 30, max: 4000 },
  minYearsExperience: { min: 0, max: 40 },
  /** Whole Egyptian pounds per month, as typed; stored in piasters. */
  salaryPounds: { min: 1, max: 1_000_000 },
  note: { max: 500 },
  /** Days a job stays published before it expires. */
  publishDays: 30,
  /** Temporary positions: end at most this many days after the start. */
  temporaryMaxDays: 366,
  /** Drafts and live jobs per organization (abuse limit). */
  openJobsPerOrganization: 50,
  pageSize: 20,
  searchQuery: { max: 80 },
} as const;

function includes<T extends string>(
  list: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (list as readonly string[]).includes(value)
  );
}

export const isJobStatus = (v: unknown): v is JobStatus =>
  includes(JOB_STATUSES, v);
export const isJobCategory = (v: unknown): v is JobCategory =>
  includes(JOB_CATEGORIES, v);
export const isEmploymentType = (v: unknown): v is EmploymentType =>
  includes(EMPLOYMENT_TYPES, v);
export const isRejectReason = (v: unknown): v is RejectReason =>
  includes(REJECT_REASONS, v);
export const isReasonCode = (v: unknown): v is ReasonCode =>
  includes(REASON_CODES, v);
export const isEmailLocale = (v: unknown): v is EmailLocale =>
  includes(EMAIL_LOCALES, v);

export const canTransition = (from: JobStatus, to: JobStatus) =>
  TRANSITIONS[from].includes(to);
