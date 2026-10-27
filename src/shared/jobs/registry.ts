import type { Queue } from "pg-boss";
import { z } from "zod";

// The single list of background jobs (ADR-004, 4a). Every queue the worker
// serves and every job the app enqueues is declared here with the Zod schema of
// its payload, so producer and consumer cannot drift apart. Payloads carry ids
// only: never personal data, file contents or object keys.

type QueueSettings = Omit<Queue, "name">;

type JobDefinition = {
  payload: z.ZodType;
  queue: QueueSettings;
};

/**
 * Dead-letter queues receive a job's payload after its last retry failed
 * (pg-boss copies it). They are declared first so the source queue can point
 * at them. A dead-letter handler records the failure; it must not retry the work.
 */
const DEAD_LETTER = {
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  expireInSeconds: 60,
  // Kept a month so an operator can inspect or redrive after an incident.
  deleteAfterSeconds: 30 * 24 * 60 * 60,
} as const satisfies QueueSettings;

const uploadPayload = z.strictObject({ uploadId: z.uuid() });
const verificationNoticePayload = z.strictObject({
  submissionId: z.uuid(),
  kind: z.enum(["received", "verified", "rejected"]),
});
const invitationPayload = z.strictObject({ invitationId: z.uuid() });
const accountNoticePayload = z.strictObject({
  suspensionId: z.uuid(),
  kind: z.enum(["suspended", "reinstated"]),
});
const applicationNoticePayload = z.strictObject({
  applicationId: z.uuid(),
  kind: z.enum(["shortlisted", "accepted", "rejected", "job_removed"]),
});
const jobNoticePayload = z.strictObject({
  jobId: z.uuid(),
  kind: z.enum(["approved", "rejected", "expired", "removed"]),
});

export const JOBS = {
  "upload.process.dead": {
    payload: uploadPayload,
    queue: DEAD_LETTER,
  },
  // Scan, re-encode and publish one upload (src/modules/uploads/processing.ts).
  "upload.process": {
    payload: uploadPayload,
    queue: {
      // 1 + 5 attempts with exponential backoff from 10 s, capped at 5 min:
      // rides out a clamd restart or a storage blip of several minutes.
      retryLimit: 5,
      retryDelay: 10,
      retryBackoff: true,
      retryDelayMax: 300,
      // An 8 MB scan plus re-encode takes seconds; a job still active after
      // this is presumed stuck and retried.
      expireInSeconds: 120,
      deleteAfterSeconds: 7 * 24 * 60 * 60,
      deadLetter: "upload.process.dead",
    },
  },
  "verification.notify.dead": {
    payload: verificationNoticePayload,
    queue: DEAD_LETTER,
  },
  // Email the user that their submission was received, verified or rejected
  // (src/modules/verification/notifications.ts). Enqueued in the same
  // transaction as the change it reports.
  "verification.notify": {
    payload: verificationNoticePayload,
    queue: {
      // Rides out an SMTP outage of about an hour. A retry after a send that
      // succeeded but was not acknowledged can deliver the email twice.
      retryLimit: 8,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 900,
      expireInSeconds: 60,
      deleteAfterSeconds: 7 * 24 * 60 * 60,
      deadLetter: "verification.notify.dead",
    },
  },
  "organization.notify.dead": {
    payload: invitationPayload,
    queue: DEAD_LETTER,
  },
  // Email an invitation to join an organization to the invited address
  // (src/modules/organizations/jobs.ts). Enqueued in the same transaction as
  // the invitation; skipped if it is no longer pending when the job runs.
  "organization.notify": {
    payload: invitationPayload,
    queue: {
      // Same retry profile as verification notices.
      retryLimit: 8,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 900,
      expireInSeconds: 60,
      deleteAfterSeconds: 7 * 24 * 60 * 60,
      deadLetter: "organization.notify.dead",
    },
  },
  "applications.notify.dead": {
    payload: applicationNoticePayload,
    queue: DEAD_LETTER,
  },
  // Email the applicant that an application was shortlisted, accepted or
  // rejected (src/modules/jobs/jobs.ts). Enqueued with the change.
  "applications.notify": {
    payload: applicationNoticePayload,
    queue: {
      retryLimit: 8,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 900,
      expireInSeconds: 60,
      deleteAfterSeconds: 7 * 24 * 60 * 60,
      deadLetter: "applications.notify.dead",
    },
  },
  "account.notify.dead": {
    payload: accountNoticePayload,
    queue: DEAD_LETTER,
  },
  // Email an account that it was suspended or reinstated
  // (src/modules/identity/suspension-jobs.ts, ADR-009). Enqueued with the change.
  "account.notify": {
    payload: accountNoticePayload,
    queue: {
      retryLimit: 8,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 900,
      expireInSeconds: 60,
      deleteAfterSeconds: 7 * 24 * 60 * 60,
      deadLetter: "account.notify.dead",
    },
  },
  "jobs.notify.dead": {
    payload: jobNoticePayload,
    queue: DEAD_LETTER,
  },
  // Email a job's creator about a moderation decision or the expiry
  // (src/modules/jobs/jobs.ts). Enqueued with the change it reports.
  "jobs.notify": {
    payload: jobNoticePayload,
    queue: {
      retryLimit: 8,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 900,
      expireInSeconds: 60,
      deleteAfterSeconds: 7 * 24 * 60 * 60,
      deadLetter: "jobs.notify.dead",
    },
  },
  // Daily (worker schedule, Africa/Cairo): published and paused jobs past
  // expires_at become expired. Idempotent; no payload.
  "jobs.expire": {
    payload: z.strictObject({}),
    queue: {
      retryLimit: 5,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 300,
      deleteAfterSeconds: 30 * 24 * 60 * 60,
    },
  },
  // Daily (worker schedule, Africa/Cairo): verified submissions whose card
  // expiry date has passed become `expired`. Idempotent; no payload.
  "verification.expire": {
    payload: z.strictObject({}),
    queue: {
      retryLimit: 5,
      retryDelay: 60,
      retryBackoff: true,
      expireInSeconds: 300,
      deleteAfterSeconds: 30 * 24 * 60 * 60,
    },
  },
} as const satisfies Record<string, JobDefinition>;

export type JobName = keyof typeof JOBS;
export type JobPayload<N extends JobName> = z.infer<
  (typeof JOBS)[N]["payload"]
>;

/** Queue names in creation order (dead-letter queues before their sources). */
export const JOB_NAMES = Object.keys(JOBS) as JobName[];

export function isJobName(value: string): value is JobName {
  return Object.hasOwn(JOBS, value);
}

/** Validates a payload for `name`. Throws a ZodError naming the bad fields. */
export function parsePayload<N extends JobName>(
  name: N,
  data: unknown,
): JobPayload<N> {
  return JOBS[name].payload.parse(data) as JobPayload<N>;
}

/** Non-throwing variant for consumers: a bad payload is dropped, not retried. */
export function safeParsePayload<N extends JobName>(
  name: N,
  data: unknown,
): JobPayload<N> | null {
  const result = JOBS[name].payload.safeParse(data);
  return result.success ? (result.data as JobPayload<N>) : null;
}
