import "server-only";
import { headers } from "next/headers";
import type { UploadDeps } from "@/modules/uploads/service";
import { getEnv } from "@/shared/config/env";
import { getDb } from "@/shared/db/client";
import { getJobClient } from "@/shared/jobs/client";
import { logger } from "@/shared/logging/logger";
import { getS3 } from "@/shared/storage/client";
import { getNationalIdKeys } from "./keys";
import { normalizeIp, type VerificationDeps } from "./service";

// Production wiring for the verification services (web app only).

export const verificationLogger = logger.child({ module: "verification" });

/** Database, job producer, logger and national ID keys (throws if keys are missing). */
export async function verificationDeps(): Promise<VerificationDeps> {
  return {
    db: getDb(),
    boss: await getJobClient(),
    logger: verificationLogger,
    keys: getNationalIdKeys(),
  };
}

/** Database, job producer and logger: everything but the keys (decisions). */
export async function decisionDeps(): Promise<
  Pick<VerificationDeps, "db" | "boss" | "logger">
> {
  return {
    db: getDb(),
    boss: await getJobClient(),
    logger: verificationLogger,
  };
}

/** What `viewDocument` needs: database and the private bucket. */
export function documentDeps(): Pick<UploadDeps, "db" | "store" | "logger"> {
  return {
    db: getDb(),
    store: { s3: getS3(), bucket: getEnv().S3_PRIVATE_BUCKET },
    logger: verificationLogger,
  };
}

/**
 * The client IP for the access log: the first X-Forwarded-For entry, which the
 * production proxy must overwrite (CLAUDE.md, rate limits). Null if absent or
 * not an IP address.
 */
export async function requestIp(): Promise<string | null> {
  return normalizeIp((await headers()).get("x-forwarded-for"));
}
