import { type Actor, can as canIdentity } from "@/modules/identity/policy";
import { isSubmissionStatus, type SubmissionStatus } from "./constants";

// Authorization for the verification module (ADR-004, 4b). Reuses identity's
// Actor, built only on the server from the session, and identity's
// `verification.review` staff action (role verification_reviewer + verified
// email + TOTP-enabled account + a session that passed TOTP).

export type VerificationAction =
  // A user submits their own documents.
  | "verification.submit"
  // A user reads their own verification status.
  | "verification.readOwn"
  // A reviewer opens the queue.
  | "verification.queue"
  // A reviewer reads one submission (masked data only).
  | "verification.read"
  // A reviewer views a document or reveals the national ID.
  | "verification.viewDocument"
  | "verification.revealNationalId"
  // A reviewer approves or rejects.
  | "verification.decide";

/**
 * `ownerId` is the submitting user. `status` is required for the actions on a
 * submission's private data and for decisions.
 */
export type VerificationResource = {
  ownerId: string;
  status?: SubmissionStatus;
};

const OWNER_ACTIONS: ReadonlySet<string> = new Set([
  "verification.submit",
  "verification.readOwn",
]);

/** Reviewer actions on a submission that must still be pending. */
const PENDING_ONLY: ReadonlySet<string> = new Set([
  "verification.viewDocument",
  "verification.revealNationalId",
  "verification.decide",
]);

const isReviewer = (actor: Actor) => canIdentity(actor, "verification.review");

/**
 * The single authorization decision for verification. Fails closed: no actor,
 * an unverified email, an unknown action, a missing resource or any unmet
 * condition → false.
 *
 * - Owner actions: the owner only. Staff roles do not widen them.
 * - `verification.queue`: a reviewer (role + MFA).
 * - Actions on a submission: a reviewer who is not its owner (nobody reviews
 *   their own); documents, the national ID and decisions only while pending.
 */
export function can(
  actor: Actor | null | undefined,
  action: VerificationAction,
  resource?: VerificationResource,
): boolean {
  if (!actor || !actor.emailVerified) return false;
  const name: string = action;

  if (name === "verification.queue") return isReviewer(actor);

  if (!resource) return false;
  if (typeof resource.ownerId !== "string" || resource.ownerId === "")
    return false;
  const isOwner = resource.ownerId === actor.userId;

  if (OWNER_ACTIONS.has(name)) return isOwner;

  if (name === "verification.read" || PENDING_ONLY.has(name)) {
    if (isOwner || !isReviewer(actor)) return false;
    if (!PENDING_ONLY.has(name)) return true;
    return isSubmissionStatus(resource.status) && resource.status === "pending";
  }

  return false;
}
