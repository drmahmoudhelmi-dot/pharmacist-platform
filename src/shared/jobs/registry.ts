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
