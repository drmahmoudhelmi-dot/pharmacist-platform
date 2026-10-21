import { sql } from "drizzle-orm";
import {
  type DrizzleTransactionLike,
  fromDrizzle,
  PgBoss,
  type Db as PgBossDb,
} from "pg-boss";
import type { Logger } from "pino";
import {
  JOB_NAMES,
  JOBS,
  type JobName,
  type JobPayload,
  parsePayload,
} from "./registry";

// pg-boss set-up shared by the web app, the worker and the migration script
// (ADR-004, 4a). pg-boss keeps its tables in its own `pgboss` schema, which
// drizzle-kit never sees (it manages `public` only). The schema and the queues
// are installed by `pnpm db:migrate` (installJobSchema); app and worker run with
// `migrate: false` so only the migration step ever changes DDL.

export type { PgBoss };

/** Logs pg-boss errors and warnings without job data (ids and messages only). */
function attachLogging(boss: PgBoss, logger: Logger): PgBoss {
  boss.on("error", (error) => logger.error({ err: error }, "job queue error"));
  boss.on("warning", (warning) =>
    logger.warn({ warning: warning.message }, "job queue warning"),
  );
  return boss;
}

/**
 * The worker's instance: supervises queues (maintenance, expiry, retries) and
 * registers itself in pg-boss's instance registry under the name "worker",
 * which is what `pnpm worker:health` reads.
 */
export function createWorkerBoss(connectionString: string, logger: Logger) {
  return attachLogging(
    new PgBoss({
      connectionString,
      application_name: "pharma-worker",
      instanceName: "worker",
      // Registry refresh; `pnpm worker:health` reads it (live = seen within 3).
      instanceHeartbeatSeconds: 10,
      max: 5,
      supervise: true,
      // Runs the cron schedules (verification.expire). Several workers may
      // all have it on: pg-boss lets one instance per interval fire a schedule.
      schedule: true,
      migrate: false,
    }),
    logger,
  );
}

/**
 * A send-only instance over an existing connection pool (the web app's), so
 * enqueuing opens no extra connections. No supervision, no registry row.
 */
export function createClientBoss(
  executeSql: PgBossDb["executeSql"],
  logger: Logger,
) {
  return attachLogging(
    new PgBoss({
      db: { executeSql },
      supervise: false,
      schedule: false,
      migrate: false,
      registerInstance: false,
    }),
    logger,
  );
}

/** A short-lived instance for operator tasks (health check, migrations). */
export function createAdminBoss(
  connectionString: string,
  logger: Logger,
  migrate = false,
) {
  return attachLogging(
    new PgBoss({
      connectionString,
      max: 1,
      supervise: false,
      schedule: false,
      migrate,
      registerInstance: false,
    }),
    logger,
  );
}

/** Creates every registry queue, or brings an existing one's settings up to date. */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const name of JOB_NAMES) {
    const settings = JOBS[name].queue;
    if (await boss.getQueue(name)) await boss.updateQueue(name, settings);
    else await boss.createQueue(name, settings);
  }
}

/** Installs or upgrades pg-boss's schema and the registry queues. Idempotent. */
export async function installJobSchema(
  connectionString: string,
  logger: Logger,
): Promise<void> {
  const boss = createAdminBoss(connectionString, logger, true);
  await boss.start();
  try {
    await ensureQueues(boss);
  } finally {
    await boss.stop({ graceful: false });
  }
}

/**
 * Enqueues a job after validating its payload against the registry. Pass the
 * Drizzle transaction as `tx` to create the job atomically with the business
 * write: it becomes visible to the worker only if the transaction commits.
 */
export async function enqueue<N extends JobName>(
  boss: PgBoss,
  name: N,
  payload: JobPayload<N>,
  options: { tx?: DrizzleTransactionLike } = {},
): Promise<string | null> {
  const data = parsePayload(name, payload);
  return boss.send(
    name,
    data,
    options.tx ? { db: fromDrizzle(options.tx, sql) } : {},
  );
}
