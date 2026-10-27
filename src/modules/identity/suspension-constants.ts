// Account suspension (ADR-009): reason codes shared by the schema, the
// service, the worker's email and the staff UI. Pure constants only.

export const SUSPENSION_REASONS = [
  "fraud_or_impersonation",
  "fake_jobs",
  "abuse_or_harassment",
  "spam",
  "terms_violation",
  "other",
] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

export const LIFT_REASONS = [
  "appeal_accepted",
  "issued_in_error",
  "other",
] as const;
export type LiftReason = (typeof LIFT_REASONS)[number];

export const SUSPENSION_NOTICE_KINDS = ["suspended", "reinstated"] as const;
export type SuspensionNoticeKind = (typeof SUSPENSION_NOTICE_KINDS)[number];

export const SUSPENSION_LIMITS = { note: { max: 500 } } as const;

const includes =
  <T extends string>(list: readonly T[]) =>
  (v: unknown): v is T =>
    typeof v === "string" && (list as readonly string[]).includes(v);

export const isSuspensionReason = includes(SUSPENSION_REASONS);
export const isLiftReason = includes(LIFT_REASONS);
