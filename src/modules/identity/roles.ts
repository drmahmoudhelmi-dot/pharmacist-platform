// Staff duty roles (ADR-002). Kept free of imports so the schema, the policy,
// the CLI and client code can all share it.
export const STAFF_ROLES = [
  "support",
  "moderator",
  "verification_reviewer",
  "billing",
  "super_admin",
] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

export function isStaffRole(value: unknown): value is StaffRole {
  return (
    typeof value === "string" &&
    (STAFF_ROLES as readonly string[]).includes(value)
  );
}
