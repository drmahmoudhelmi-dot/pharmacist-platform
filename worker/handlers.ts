import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import { sendInvitationNotice } from "@/modules/organizations/jobs";
import { failUpload, processUpload } from "@/modules/uploads/processing";
import {
  expireVerifications,
  sendVerificationNotice,
} from "@/modules/verification/jobs";
import type { ScanResult } from "@/shared/av/clamd";
import type { EmailSender } from "@/shared/email/sender";
import type { PgBoss } from "@/shared/jobs/boss";
import { type JobName, safeParsePayload } from "@/shared/jobs/registry";
import type { ObjectStore } from "@/shared/storage/objects";

// Registers a handler for every queue in the job registry. A payload that does
// not match its schema is logged and completed, not retried: retrying cannot
// fix it. Any other error fails the attempt and pg-boss retries with backoff;
// after the last retry the payload moves to the queue's dead-letter queue.

export type WorkerDeps = {
  db: NodePgDatabase;
  store: ObjectStore;
  scan: (bytes: Uint8Array) => Promise<ScanResult>;
  emailSender: EmailSender;
  /** Public origin for links in emails, without a trailing slash. */
  appUrl: string;
  logger: Logger;
};

type Handler = (
  deps: WorkerDeps,
  data: unknown,
  jobId: string,
) => Promise<void>;

function payloadOf<N extends JobName>(
  deps: WorkerDeps,
  name: N,
  data: unknown,
  jobId: string,
) {
  const payload = safeParsePayload(name, data);
  if (!payload)
    deps.logger.error({ event: "job.invalid_payload", queue: name, jobId });
  return payload;
}

export const HANDLERS: Record<JobName, Handler> = {
  "upload.process": async (deps, data, jobId) => {
    const payload = payloadOf(deps, "upload.process", data, jobId);
    if (payload) await processUpload(deps, payload.uploadId);
  },
  "upload.process.dead": async (deps, data, jobId) => {
    const payload = payloadOf(deps, "upload.process.dead", data, jobId);
    if (payload) await failUpload(deps, payload.uploadId);
  },
  "verification.notify": async (deps, data, jobId) => {
    const payload = payloadOf(deps, "verification.notify", data, jobId);
    if (payload)
      await sendVerificationNotice(deps, payload.submissionId, payload.kind);
  },
  "verification.notify.dead": async (deps, data, jobId) => {
    // Every retry failed: the user gets no email for this event. Recorded for
    // the operator (ids only); the submission itself is unaffected.
    const payload = payloadOf(deps, "verification.notify.dead", data, jobId);
    if (payload)
      deps.logger.error({
        event: "verification.notice_failed",
        submissionId: payload.submissionId,
        kind: payload.kind,
      });
  },
  "organization.notify": async (deps, data, jobId) => {
    const payload = payloadOf(deps, "organization.notify", data, jobId);
    if (payload) await sendInvitationNotice(deps, payload.invitationId);
  },
  "organization.notify.dead": async (deps, data, jobId) => {
    // Every retry failed: the invitee gets no email, but the invitation still
    // shows on their organizations page. Recorded for the operator (ids only).
    const payload = payloadOf(deps, "organization.notify.dead", data, jobId);
    if (payload)
      deps.logger.error({
        event: "organization.invitation_notice_failed",
        invitationId: payload.invitationId,
      });
  },
  "verification.expire": async (deps, data, jobId) => {
    if (payloadOf(deps, "verification.expire", data, jobId))
      await expireVerifications(deps);
  },
};

/**
 * Recurring jobs, created or updated by the worker at start-up (idempotent).
 * Cron in Africa/Cairo: 00:17 daily, just after the date changes in Egypt.
 */
export const SCHEDULES = [
  { name: "verification.expire", cron: "17 0 * * *", tz: "Africa/Cairo" },
] as const;

export async function registerSchedules(boss: PgBoss) {
  for (const s of SCHEDULES)
    await boss.schedule(s.name, s.cron, {}, { tz: s.tz });
}

/** Concurrent jobs per queue in this process. Each upload job holds ≤ 8 MB plus decode buffers. */
const CONCURRENCY: Record<JobName, number> = {
  "upload.process": 2,
  "upload.process.dead": 1,
  "verification.notify": 2,
  "verification.notify.dead": 1,
  "verification.expire": 1,
  "organization.notify": 2,
  "organization.notify.dead": 1,
};

export async function registerHandlers(boss: PgBoss, deps: WorkerDeps) {
  for (const name of Object.keys(HANDLERS) as JobName[]) {
    const handler = HANDLERS[name];
    await boss.work(
      name,
      { localConcurrency: CONCURRENCY[name], batchSize: 1 },
      async ([job]) => {
        if (!job) return;
        const started = Date.now();
        try {
          await handler(deps, job.data, job.id);
          deps.logger.info({
            event: "job.completed",
            queue: name,
            jobId: job.id,
            ms: Date.now() - started,
          });
        } catch (error) {
          deps.logger.error({
            event: "job.failed",
            queue: name,
            jobId: job.id,
            attempt: job.retryCount + 1,
            // Message only: errors from storage or clamd carry no personal data,
            // but job data is never logged.
            error: error instanceof Error ? error.message : "unknown error",
          });
          throw error;
        }
      },
    );
  }
}
