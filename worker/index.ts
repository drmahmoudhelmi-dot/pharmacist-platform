// Background worker (ADR-001, ADR-004): `pnpm worker`. Runs the pg-boss
// queues from src/shared/jobs/registry.ts. Needs PostgreSQL (migrated with
// `pnpm db:migrate`, which also installs pg-boss's schema), object storage and
// clamd. Stops gracefully on SIGTERM/SIGINT: no new jobs are fetched, running
// jobs get up to 30 s to finish, unfinished ones are retried later.
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import sharp from "sharp";
import { scanBuffer } from "@/shared/av/clamd";
import { parseWorkerEnv } from "@/shared/config/env";
import { createWorkerBoss } from "@/shared/jobs/boss";
import { createSmtpSender } from "@/shared/email/smtp";
import { createLogger } from "@/shared/logging/logger";
import { getS3 } from "@/shared/storage/client";
import { registerHandlers, registerSchedules } from "./handlers";

const SHUTDOWN_TIMEOUT_MS = 30_000;

async function main() {
  const env = parseWorkerEnv(process.env);
  const logger = createLogger({ base: { process: "worker" } });
  // One image at a time per job; libvips' cache only costs memory here.
  sharp.cache(false);

  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 5 });
  const boss = createWorkerBoss(env.DATABASE_URL, logger);
  const clamd = { host: env.CLAMAV_HOST, port: env.CLAMAV_PORT };

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ event: "worker.stopping", signal });
    try {
      await boss.stop({ graceful: true, timeout: SHUTDOWN_TIMEOUT_MS });
      await pool.end();
      logger.info({ event: "worker.stopped" });
      process.exit(0);
    } catch (error) {
      logger.error({ err: error, event: "worker.stop_failed" });
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Retries for a while so the worker can start before the database is up.
  await boss.start({ attempts: 5 });
  await registerHandlers(boss, {
    db: drizzle(pool),
    boss,
    store: { s3: getS3(), bucket: env.S3_PRIVATE_BUCKET },
    scan: (bytes) => scanBuffer(clamd, bytes),
    emailSender: createSmtpSender({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      from: env.EMAIL_FROM,
    }),
    appUrl: env.APP_URL.replace(/\/+$/, ""),
    logger,
  });
  await registerSchedules(boss);
  logger.info({ event: "worker.started" });
}

main().catch((error: unknown) => {
  // The env parser names missing keys only, never values.
  console.error(
    "Worker failed to start:",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exit(1);
});
