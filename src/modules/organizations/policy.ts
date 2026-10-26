import type { Actor } from "@/modules/identity/policy";
import { isMemberRole, type MemberRole } from "./constants";

// Authorization for the organizations module (ADR-005). Reuses identity's
// Actor, built only on the server from the session. The actor's role in the
// organization is loaded by the service from organization_member with the
// session's user id; it never comes from input. Staff roles do not widen
// access to organizations.

export type OrganizationAction =
  // Any signed-in user with a verified email.
  | "organization.create"
  // Any member.
  | "organization.read"
  | "organization.leave"
  // Owners and recruiters: jobs and applications (step 6).
  | "jobs.manage"
  // Owners only.
  | "organization.update"
  | "members.read"
  | "invitations.read"
  | "invitation.create"
  | "invitation.revoke"
  // Owners only, never on themselves.
  | "member.remove"
  | "member.changeRole";

export type OrganizationResource = {
  /** The actor's own role in the organization; absent = not a member. */
  actorRole?: MemberRole | null;
  /** Role being granted, revoked or removed (invitations, members). */
  targetRole?: MemberRole;
  /** True when the target member is the actor. */
  targetIsSelf?: boolean;
};

/**
 * The single authorization decision for organizations. Fails closed: no
 * actor, an unverified email, an unknown action, no membership or any unmet
 * condition → false. The "at least one owner" rule needs the database and is
 * enforced by the service under a row lock.
 *
 * Roles (ADR-005, amended 2026-10-26): owners manage the organization, its
 * members and invitations; recruiters manage jobs and applications only.
 */
export function can(
  actor: Actor | null | undefined,
  action: OrganizationAction,
  resource?: OrganizationResource,
): boolean {
  if (!actor || !actor.emailVerified) return false;
  const name: string = action;

  if (name === "organization.create") return true;

  const role = resource?.actorRole;
  if (!isMemberRole(role)) return false;

  switch (name) {
    case "organization.read":
    case "organization.leave":
    case "jobs.manage":
      return true;
    case "organization.update":
    case "members.read":
    case "invitations.read":
      return role === "owner";
    case "invitation.create":
    case "invitation.revoke":
      return role === "owner" && isMemberRole(resource?.targetRole);
    case "member.remove":
    case "member.changeRole":
      // Leaving is its own action; these target someone else.
      return (
        role === "owner" &&
        resource?.targetIsSelf === false &&
        isMemberRole(resource.targetRole)
      );
    default:
      return false;
  }
}
