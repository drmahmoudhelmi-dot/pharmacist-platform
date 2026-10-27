import { type Actor, can as canIdentity } from "@/modules/identity/policy";
import type { MemberRole } from "@/modules/organizations/constants";
import { can as canOrganization } from "@/modules/organizations/policy";
import {
  type ApplicationStatus,
  canMoveApplication,
  EDITABLE,
  isApplicationStatus,
  isJobStatus,
  type JobStatus,
  REPORTABLE,
  WITHDRAWABLE,
} from "./constants";

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
  | "job.review"
  // A live job taken down (ADR-009).
  | "job.takedown"
  // Any signed-in member reports a live job of another organization.
  | "job.report";

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

  if (name === "job.takedown")
    return (
      isModerator(actor) &&
      !resource?.actorRole &&
      (resource?.status === "published" || resource?.status === "paused")
    );
  if (name === "job.report")
    return (
      // Not one's own organization's job; only live jobs.
      !resource?.actorRole &&
      isJobStatus(resource?.status) &&
      REPORTABLE.includes(resource.status)
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

// ---------------------------------------------------------------------------
// Applications (ADR-007)

export type ApplicationAction =
  // A signed-in user applies to a live job of an organization they are not in.
  | "application.apply"
  // The applicant reads or withdraws their own application.
  | "application.readOwn"
  | "application.withdraw"
  // The job's organization (owner or recruiter).
  | "application.read"
  | "application.move";

export type ApplicationResource = {
  /** The actor's role in the job's organization; absent = not a member. */
  actorRole?: MemberRole | null;
  /** The applicant's user id, for the applicant's own actions. */
  applicantId?: string;
  status?: ApplicationStatus;
  /** The target status of `application.move`. */
  to?: ApplicationStatus;
  /** The job's status: applications of a removed job are frozen (ADR-009). */
  jobStatus?: JobStatus;
};

/** Fails closed like `can` above. */
export function canApplication(
  actor: Actor | null | undefined,
  action: ApplicationAction,
  resource?: ApplicationResource,
): boolean {
  if (!actor || !actor.emailVerified) return false;
  const name: string = action;
  switch (name) {
    case "application.apply":
      // Nobody applies to their own organization's jobs.
      return resource?.actorRole == null;
    case "application.readOwn":
      return resource?.applicantId === actor.userId;
    case "application.withdraw":
      return (
        resource?.applicantId === actor.userId &&
        isApplicationStatus(resource.status) &&
        WITHDRAWABLE.includes(resource.status)
      );
    case "application.read":
      return canOrganization(actor, "jobs.manage", {
        actorRole: resource?.actorRole,
      });
    case "application.move":
      return (
        canOrganization(actor, "jobs.manage", {
          actorRole: resource?.actorRole,
        }) &&
        // Nobody decides their own application, even after joining the
        // organization; the applicant id is required.
        typeof resource?.applicantId === "string" &&
        resource.applicantId !== actor.userId &&
        // The employer never acts as the applicant (withdraw is theirs).
        resource?.to !== "withdrawn" &&
        // A job taken down by moderation freezes its applications.
        isJobStatus(resource?.jobStatus) &&
        resource.jobStatus !== "removed" &&
        isApplicationStatus(resource?.status) &&
        isApplicationStatus(resource?.to) &&
        canMoveApplication(resource.status, resource.to)
      );
    default:
      return false;
  }
}
