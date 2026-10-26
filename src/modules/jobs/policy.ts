import { type Actor, can as canIdentity } from "@/modules/identity/policy";
import type { MemberRole } from "@/modules/organizations/constants";
import { can as canOrganization } from "@/modules/organizations/policy";
import { EDITABLE, isJobStatus, type JobStatus } from "./constants";

// Authorization for the jobs module (ADR-006). An employer action needs the
// actor's role in the job's organization (loaded by the service from the
// organizations module, never from input) to allow `jobs.manage`, plus a job
// status that permits the action. Moderation needs identity's
// `moderation.access` (role moderator + MFA) and is refused for jobs of an
// organization the moderator belongs to.

export type JobAction =
  // Employer side (owner or recruiter of the organization).
  | "job.create"
  | "job.read"
  | "job.edit"
  | "job.delete"
  | "job.submit"
  | "job.pause"
  | "job.resume"
  | "job.close"
  | "job.copy"
  // Moderator side.
  | "job.reviewQueue"
  | "job.review";

export type JobResource = {
  /** The actor's role in the job's organization; absent = not a member. */
  actorRole?: MemberRole | null;
  /** Required for every action on an existing job. */
  status?: JobStatus;
};

/** Status each employer action needs. */
const NEEDS: Record<string, readonly JobStatus[]> = {
  "job.edit": EDITABLE,
  // Only drafts; the service also refuses a draft that was ever submitted.
  "job.delete": ["draft"],
  "job.submit": EDITABLE,
  "job.pause": ["published"],
  "job.resume": ["paused"],
  "job.close": ["published", "paused"],
};

const isModerator = (actor: Actor) => canIdentity(actor, "moderation.access");

/** Fails closed: no actor, an unverified email, an unknown action → false. */
export function can(
  actor: Actor | null | undefined,
  action: JobAction,
  resource?: JobResource,
): boolean {
  if (!actor || !actor.emailVerified) return false;
  const name: string = action;

  if (name === "job.reviewQueue") return isModerator(actor);
  if (name === "job.review")
    return (
      isModerator(actor) &&
      // Nobody moderates their own organization's jobs.
      !resource?.actorRole &&
      resource?.status === "pending_review"
    );

  if (
    !canOrganization(actor, "jobs.manage", { actorRole: resource?.actorRole })
  )
    return false;

  if (name === "job.create") return true;
  if (!isJobStatus(resource?.status)) return false;
  if (name === "job.read" || name === "job.copy") return true;
  const allowed = NEEDS[name];
  return allowed !== undefined && allowed.includes(resource.status);
}
