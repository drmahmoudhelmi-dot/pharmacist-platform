// Allowed values for the admin audit log (ADR-008). Kept free of imports so
// the schema, the leaf writer and client components can share them.

export const AUDIT_ACTIONS = [
  "role.granted",
  "role.revoked",
  "verification.decided",
  "job.moderated",
  "account.data_exported",
  // ADR-009 (step 7b)
  "account.suspended",
  "account.reinstated",
  "job.removed",
  "job.reports_dismissed",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// `user`: a regular member acting on their own account (data export).
export const ACTOR_KINDS = ["staff", "user", "operator", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const TARGET_TYPES = ["user", "verification_submission", "job"] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

export const AUDIT_PAGE_SIZE = 50;

const includes = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);

export const isAuditAction = (v: unknown): v is AuditAction =>
  includes(AUDIT_ACTIONS, v);
export const isTargetType = (v: unknown): v is TargetType =>
  includes(TARGET_TYPES, v);
