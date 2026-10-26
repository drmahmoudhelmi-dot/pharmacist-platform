// Allowed values and limits for organizations (ADR-005). Kept free of imports
// so the schema, the policy, validation and client components can share them.

export const ORGANIZATION_KINDS = ["pharmacy", "chain"] as const;
export type OrganizationKind = (typeof ORGANIZATION_KINDS)[number];

/**
 * Highest privilege first (product owner decision, 2026-10-26: owner and
 * recruiter only). Owners manage everything; recruiters manage jobs and
 * applications.
 */
export const MEMBER_ROLES = ["owner", "recruiter"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/**
 * Roles that may appear in organization_audit history. `admin` existed until
 * migration 0007 and stays readable there; it can no longer be granted.
 */
export const AUDIT_ROLES = ["owner", "admin", "recruiter"] as const;

export const INVITATION_STATUSES = [
  "pending",
  "accepted",
  "declined",
  "revoked",
  "expired",
] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const AUDIT_ACTIONS = [
  "organization.created",
  "organization.updated",
  "invitation.created",
  "invitation.revoked",
  "invitation.accepted",
  "invitation.declined",
  "member.role_changed",
  "member.removed",
  "member.left",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const EMAIL_LOCALES = ["ar", "en"] as const;
export type EmailLocale = (typeof EMAIL_LOCALES)[number];

export const LIMITS = {
  name: { min: 2, max: 120 },
  addressLine: { max: 200 },
  email: { max: 254 },
  /** Organizations a user may create. */
  createdPerUser: 5,
  membersPerOrganization: 50,
  pendingInvitations: 20,
  /** New invitations per organization in a rolling 24 hours. */
  invitationsPerDay: 30,
  invitationDays: 7,
} as const;

function includes<T extends string>(
  list: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (list as readonly string[]).includes(value)
  );
}

export const isOrganizationKind = (v: unknown): v is OrganizationKind =>
  includes(ORGANIZATION_KINDS, v);
export const isMemberRole = (v: unknown): v is MemberRole =>
  includes(MEMBER_ROLES, v);
export const isInvitationStatus = (v: unknown): v is InvitationStatus =>
  includes(INVITATION_STATUSES, v);
export const isEmailLocale = (v: unknown): v is EmailLocale =>
  includes(EMAIL_LOCALES, v);
