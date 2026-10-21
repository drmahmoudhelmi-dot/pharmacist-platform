import "server-only";
import type { UploadDeps } from "@/modules/uploads/service";
import { getEnv } from "@/shared/config/env";
import { getDb } from "@/shared/db/client";
import { getJobClient } from "@/shared/jobs/client";
import { logger } from "@/shared/logging/logger";
import { getS3 } from "@/shared/storage/client";

export const uploadsLogger = logger.child({ module: "uploads" });

/** Production wiring for the uploads module's HTTP handlers. */
export async function uploadDeps(): Promise<UploadDeps> {
  return {
    db: getDb(),
    store: { s3: getS3(), bucket: getEnv().S3_PRIVATE_BUCKET },
    boss: await getJobClient(),
    logger: uploadsLogger,
  };
}

/** Storage or queue down: logged with no request data, answered generically. */
export function unavailable(error: unknown): Response {
  uploadsLogger.error(
    { err: error, event: "upload.unavailable" },
    "upload failed",
  );
  return Response.json(
    { error: "unavailable" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
