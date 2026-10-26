import { existsSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sendInvitationNotice } from "../src/modules/organizations/jobs";
import { processUpload } from "../src/modules/uploads/processing";
import { sendVerificationNotice } from "../src/modules/verification/jobs";
import { getEnv } from "../src/shared/config/env";
import { createSmtpSender } from "../src/shared/email/smtp";
import { createClientBoss } from "../src/shared/jobs/boss";
import { createLogger } from "../src/shared/logging/logger";
import { getS3 } from "../src/shared/storage/client";

// Test-only stand-in for `pnpm worker` (E2E runs no worker and no clamd, see
// .github/workflows/ci.yml). Runs the worker's real code paths in the test
// process against the local services: the upload pipeline (re-encode, store,
// mark clean) with a scanner stub that reports clean, and the verification
// and organization invitation email jobs sending through Mailpit. Nothing here is imported by the app.
//
// Uploads are processed by id, only the test's own, so specs running in
// parallel (uploads.spec.ts expects its uploads to stay `processing`) are not
// affected. Their queued `upload.process` jobs stay behind; a real worker
// would skip them because the upload is no longer `processing`.

if (!process.env.DATABASE_URL && existsSync(".env"))
  process.loadEnvFile(".env");

const logger = createLogger({ level: "silent" });

function local() {
  const env = getEnv();
  const host = new URL(env.DATABASE_URL).hostname;
  if (host !== "localhost" && host !== "127.0.0.1")
    throw new Error("E2E worker helpers only run against a local database.");
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 2 });
  return { env, pool, db: drizzle(pool) };
}

/** Scans (stub: clean), re-encodes and publishes these uploads, like the worker. */
export async function processUploads(ids: readonly string[]): Promise<void> {
  const { env, pool, db } = local();
  try {
    for (const id of ids) {
      const outcome = await processUpload(
        {
          db,
          store: { s3: getS3(), bucket: env.S3_PRIVATE_BUCKET },
          scan: async () => ({ infected: false }),
          logger,
        },
        id,
      );
      if (outcome !== "clean") throw new Error(`upload ${id}: ${outcome}`);
    }
  } finally {
    await pool.end();
  }
}

/** Sends every queued verification email to Mailpit through the worker's handler code. */
export async function sendQueuedVerificationEmails(): Promise<number> {
  const { env, pool, db } = local();
  const boss = createClientBoss(
    (text, values) => pool.query(text, values),
    logger,
  );
  await boss.start();
  let sent = 0;
  try {
    for (;;) {
      const jobs = await boss.fetch<{
        submissionId: string;
        kind: "received" | "verified" | "rejected";
      }>("verification.notify", { batchSize: 20 });
      if (jobs.length === 0) return sent;
      for (const job of jobs) {
        await sendVerificationNotice(
          {
            db,
            emailSender: createSmtpSender({
              host: env.SMTP_HOST,
              port: env.SMTP_PORT,
              from: env.EMAIL_FROM,
            }),
            logger,
            appUrl: env.APP_URL,
          },
          job.data.submissionId,
          job.data.kind,
        );
        await boss.complete("verification.notify", job.id);
        sent += 1;
      }
    }
  } finally {
    await boss.stop({ graceful: false });
    await pool.end();
  }
}

/** Sends every queued organization invitation email to Mailpit, like the worker. */
export async function sendQueuedInvitationEmails(): Promise<number> {
  const { env, pool, db } = local();
  const boss = createClientBoss(
    (text, values) => pool.query(text, values),
    logger,
  );
  await boss.start();
  let sent = 0;
  try {
    for (;;) {
      const jobs = await boss.fetch<{ invitationId: string }>(
        "organization.notify",
        { batchSize: 20 },
      );
      if (jobs.length === 0) return sent;
      for (const job of jobs) {
        await sendInvitationNotice(
          {
            db,
            emailSender: createSmtpSender({
              host: env.SMTP_HOST,
              port: env.SMTP_PORT,
              from: env.EMAIL_FROM,
            }),
            logger,
            appUrl: env.APP_URL,
          },
          job.data.invitationId,
        );
        await boss.complete("organization.notify", job.id);
        sent += 1;
      }
    }
  } finally {
    await boss.stop({ graceful: false });
    await pool.end();
  }
}

/** Access-log rows for a user's latest submission, by action. */
export async function accessLogCounts(
  email: string,
): Promise<Record<string, number>> {
  const { pool } = local();
  try {
    const result = await pool.query<{ action: string; n: number }>(
      `select l.action, count(*)::int as n
         from document_access_log l
         join verification_submission s on s.id = l.submission_id
         join "user" u on u.id = s.user_id
        where u.email = $1
        group by l.action`,
      [email],
    );
    return Object.fromEntries(result.rows.map((r) => [r.action, r.n]));
  } finally {
    await pool.end();
  }
}
