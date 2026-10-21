import type { Actor } from "@/modules/identity/policy";

// Authorization for the uploads module (ADR-004, 4a). Reuses identity's Actor,
// which is only ever built on the server from the session.

export type UploadAction =
  "upload.create" | "upload.readStatus" | "upload.view";

/** The upload's owner; for `upload.create`, the account the file is for. */
export type UploadResource = { ownerId: string };

/** Listed explicitly so new actions fail closed until a rule is written. */
const OWNER_ONLY: ReadonlySet<string> = new Set([
  "upload.create",
  "upload.readStatus",
  "upload.view",
]);

/**
 * The single authorization decision for uploads. Fails closed: no actor, an
 * unverified email, an unknown action, a missing resource or any unmet
 * condition → false.
 *
 * Everything is owner-only in 4a: a user uploads for their own account and
 * reads the status of, and views, only their own files. Staff roles do not
 * widen this; step 4b lets verification reviewers view documents through an
 * authorizer of its own (see `issueSignedUrl`), which also logs the access.
 */
export function can(
  actor: Actor | null | undefined,
  action: UploadAction,
  resource?: UploadResource,
): boolean {
  if (!actor || !actor.emailVerified || !resource) return false;
  if (typeof resource.ownerId !== "string" || resource.ownerId === "")
    return false;
  const name: string = action;
  if (OWNER_ONLY.has(name)) return resource.ownerId === actor.userId;
  return false;
}
