import "server-only";
import { getPool } from "@/shared/db/client";
import { logger } from "@/shared/logging/logger";
import { createClientBoss, type PgBoss } from "./boss";

// The web app's job producer: one started, send-only pg-boss instance per
// process over the app's own pool. Cached on globalThis so dev hot reloads do
// not create more. A failed start is not cached, so the next request retries.

const globalForJobs = globalThis as unknown as {
  __jobClient?: Promise<PgBoss>;
};

export function getJobClient(): Promise<PgBoss> {
  globalForJobs.__jobClient ??= (async () => {
    const boss = createClientBoss(
      (text, values) => getPool().query(text, values),
      logger.child({ component: "jobs" }),
    );
    await boss.start();
    return boss;
  })().catch((error: unknown) => {
    globalForJobs.__jobClient = undefined;
    throw error;
  });
  return globalForJobs.__jobClient;
}
