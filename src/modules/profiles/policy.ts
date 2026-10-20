import type { Actor } from "@/modules/identity/policy";
import { isVisibility, type Visibility } from "./constants";

// Authorization for the profiles module (ADR-003). Reuses identity's Actor,
// which is only ever built on the server from the session.

export type ProfileAction =
  | "profile.read"
  | "profile.update"
  | "professionalDetails.read"
  | "professionalDetails.update";

/** `visibility` is required for `profile.read`; without it only the owner may read. */
export type ProfileResource = { ownerId: string; visibility?: Visibility };

/** True for owner-only actions. Listed explicitly so new actions fail closed. */
const OWNER_ONLY: ReadonlySet<string> = new Set([
  "profile.update",
  "professionalDetails.read",
  "professionalDetails.update",
]);

/**
 * The single authorization decision for profiles. Fails closed: no actor, an
 * unknown action, a missing resource or any unmet condition → false.
 *
 * - `profile.read`: the owner always; any other signed-in member with a
 *   verified email when the profile's visibility is `members`. There is no
 *   anonymous (internet-public) read.
 * - Everything else: the owner only. Staff roles do not widen access.
 */
export function can(
  actor: Actor | null | undefined,
  action: ProfileAction,
  resource?: ProfileResource,
): boolean {
  if (!actor || !actor.emailVerified || !resource) return false;
  if (typeof resource.ownerId !== "string" || resource.ownerId === "")
    return false;
  const isOwner = resource.ownerId === actor.userId;
  const name: string = action;

  if (name === "profile.read") {
    if (isOwner) return true;
    return (
      isVisibility(resource.visibility) && resource.visibility === "members"
    );
  }

  if (OWNER_ONLY.has(name)) return isOwner;

  return false;
}

/**
 * The visibility rule as a pure function, used by the read service after the
 * row is loaded: the profile is shown only when `can(…, "profile.read")` says so.
 */
export function canViewProfile(
  viewer: Actor | null | undefined,
  row: { userId: string; visibility: string },
): boolean {
  return can(viewer, "profile.read", {
    ownerId: row.userId,
    visibility: isVisibility(row.visibility) ? row.visibility : undefined,
  });
}
