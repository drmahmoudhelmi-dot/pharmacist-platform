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
  // Owners and admins.
  | "organization.update"
  | "members.read"
  | "invitations.read"
  // Owners any role; admins recruiters only (`targetRole`).
  | "invitation.create"
  | "invitation.revoke"
  | "member.remove"
  // Owners only, never on themselves.
  | "member.changeRole";

export type OrganizationResource = {
  /** The actor's own role in the organization; absent = not a member. */
  actorRole?: MemberRole | null;
  /** Role being granted, revoked or removed (invitations, members). */
  targetRole?: MemberRole;
  /** True when the target member is the actor. */
  targetIsSelf?: boolean;
};

const MANAGERS: readonly MemberRole[] = ["owner", "admin"];

/**
 * An owner may act on any role; an admin only on recruiters. Used for
 * inviting, revoking invitations and removing members.
 */
function mayManageRole(actorRole: MemberRole, targetRole: unknown): boolean {
  if (!isMemberRole(targetRole)) return false;
  if (actorRole === "owner") return true;
  return actorRole === "admin" && targetRole === "recruiter";
}

/**
 * The single authorization decision for organizations. Fails closed: no
 * actor, an unverified email, an unknown action, no membership or any unmet
 * condition → false. The "at least one owner" rule needs the database and is
 * enforced by the service under a row lock.
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
      return true;
    case "organization.update":
    case "members.read":
    case "invitations.read":
      return MANAGERS.includes(role);
    case "invitation.create":
    case "invitation.revoke":
      return mayManageRole(role, resource?.targetRole);
    case "member.remove":
      // Leaving is its own action; removal targets someone else.
      if (resource?.targetIsSelf !== false) return false;
      return mayManageRole(role, resource?.targetRole);
    case "member.changeRole":
      return (
        role === "owner" &&
        resource?.targetIsSelf === false &&
        isMemberRole(resource.targetRole)
      );
    default:
      return false;
  }
}
