import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import type { Actor } from "@/modules/identity/policy";
import { consumeQuota } from "@/modules/identity/rate-limit";
import { enqueue, type PgBoss } from "@/shared/jobs/boss";
import {
  deleteObject,
  type ObjectStore,
  presignGet,
  putObject,
} from "@/shared/storage/objects";
import {
  isRejectReason,
  isUploadPurpose,
  isUploadStatus,
  OUTPUT_TYPE,
  QUARANTINE_PREFIX,
  type RejectReason,
  SIGNED_URL_TTL_SECONDS,
  UPLOAD_LIMITS,
  type UploadPurpose,
  type UploadStatus,
} from "./constants";
import { detectImageType } from "./detect";
import { can } from "./policy";
import { upload } from "./schema";

// All database and storage access for uploads made on behalf of a user
// (ADR-004, 4a). Every function takes the Actor built from the session; the
// owner id always comes from `actor.userId`, never from input. Object keys stay
// on the server: results carry the upload id, status and reason code only.
// The worker side (scan, re-encode) is in processing.ts.

type Db = NodePgDatabase;

export type UploadDeps = {
  db: Db;
  store: ObjectStore;
  boss: PgBoss;
  logger: Logger;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

async function countProcessing(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(upload)
    .where(and(eq(upload.userId, userId), eq(upload.status, "processing")));
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Admission: cheap checks before the request body is read.

export type AdmitResult =
  | { ok: true }
  | {
      ok: false;
      error: "forbidden" | "rate_limited" | "too_many_pending";
      retryAfter?: number;
    };

/**
 * Counts this attempt against the hourly limit (every attempt counts, also
 * ones rejected later) and checks the processing cap, so an over-limit client
 * is turned away before it sends 8 MB.
 */
export async function admitUpload(db: Db, actor: Actor): Promise<AdmitResult> {
  if (!can(actor, "upload.create", { ownerId: actor.userId }))
    return { ok: false, error: "forbidden" };
  const quota = await consumeQuota(
    db,
    `upload|user|${actor.userId}`,
    UPLOAD_LIMITS.hourly,
  );
  if (!quota.allowed)
    return { ok: false, error: "rate_limited", retryAfter: quota.retryAfter };
  if (
    (await countProcessing(db, actor.userId)) >=
    UPLOAD_LIMITS.maxProcessingPerUser
  )
    return { ok: false, error: "too_many_pending" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Create

export type CreateUploadError =
  | "forbidden"
  | "invalid_request"
  | "too_large"
  | "unsupported_type"
  | "too_many_pending";

export type CreateUploadResult =
  | { ok: true; upload: { id: string; status: "processing" } }
  | { ok: false; error: CreateUploadError };

/**
 * Stores the file in quarantine under a random key, records the upload as
 * `processing` and enqueues `upload.process` in the same transaction, so a row
 * never exists without its job (or the job without its row). The processing
 * cap is re-checked under a per-user advisory lock, so concurrent uploads
 * cannot exceed it.
 */
export async function createUpload(
  deps: UploadDeps,
  actor: Actor,
  input: { purpose: unknown; bytes: Uint8Array },
): Promise<CreateUploadResult> {
  if (!can(actor, "upload.create", { ownerId: actor.userId }))
    return { ok: false, error: "forbidden" };
  if (!isUploadPurpose(input.purpose))
    return { ok: false, error: "invalid_request" };
  const size = input.bytes.byteLength;
  if (size === 0) return { ok: false, error: "invalid_request" };
  if (size > UPLOAD_LIMITS.maxBytes) return { ok: false, error: "too_large" };
  const contentType = detectImageType(input.bytes);
  if (!contentType) return { ok: false, error: "unsupported_type" };

  const quarantineKey = `${QUARANTINE_PREFIX}${randomUUID()}`;
  // Stored as opaque bytes: nothing serves quarantine objects.
  await putObject(
    deps.store,
    quarantineKey,
    input.bytes,
    "application/octet-stream",
  );

  const discardQuarantine = () =>
    deleteObject(deps.store, quarantineKey).catch((error: unknown) =>
      deps.logger.error(
        { err: error, event: "upload.quarantine_cleanup_failed" },
        "could not delete quarantine object",
      ),
    );

  let id: string | null;
  try {
    id = await deps.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`upload:${actor.userId}`}, 0))`,
      );
      const [pending] = await tx
        .select({ n: count() })
        .from(upload)
        .where(
          and(eq(upload.userId, actor.userId), eq(upload.status, "processing")),
        );
      if ((pending?.n ?? 0) >= UPLOAD_LIMITS.maxProcessingPerUser) return null;
      const [row] = await tx
        .insert(upload)
        .values({
          userId: actor.userId,
          purpose: input.purpose as UploadPurpose,
          quarantineKey,
          contentType,
          byteSize: size,
        })
        .returning({ id: upload.id });
      if (!row) throw new Error("upload insert returned no row");
      await enqueue(deps.boss, "upload.process", { uploadId: row.id }, { tx });
      return row.id;
    });
  } catch (error) {
    await discardQuarantine();
    throw error;
  }
  if (!id) {
    await discardQuarantine();
    return { ok: false, error: "too_many_pending" };
  }
  deps.logger.info({
    event: "upload.created",
    uploadId: id,
    userId: actor.userId,
    contentType,
    byteSize: size,
  });
  return { ok: true, upload: { id, status: "processing" } };
}

// ---------------------------------------------------------------------------
// Status

export type UploadStatusView = {
  id: string;
  status: UploadStatus;
  rejectReason: RejectReason | null;
};

/** The owner's view of an upload, or null when it is missing or not theirs. */
export async function getUploadStatus(
  db: Db,
  actor: Actor,
  id: unknown,
): Promise<UploadStatusView | null> {
  if (!isUuid(id)) return null;
  // Scoped by owner in the query, so a missing check would still fail closed.
  const [row] = await db
    .select({
      id: upload.id,
      userId: upload.userId,
      status: upload.status,
      rejectReason: upload.rejectReason,
    })
    .from(upload)
    .where(and(eq(upload.id, id), eq(upload.userId, actor.userId)))
    .limit(1);
  if (!row || !can(actor, "upload.readStatus", { ownerId: row.userId }))
    return null;
  if (!isUploadStatus(row.status)) return null;
  return {
    id: row.id,
    status: row.status,
    rejectReason: isRejectReason(row.rejectReason) ? row.rejectReason : null,
  };
}

// ---------------------------------------------------------------------------
// Attaching uploads to another module's record (verification, 4b)

/** What a caller attaching uploads learns about each of the actor's own uploads. */
export type AttachableUpload = { id: string; status: UploadStatus };

/**
 * The actor's own uploads among `ids` with the given purpose, and their status.
 * Ids that are malformed, missing, someone else's or of another purpose are
 * simply absent from the result, so a caller cannot tell them apart. Accepts a
 * transaction, so the check can run inside the caller's write.
 */
export async function findOwnUploads(
  db: Pick<Db, "select">,
  actor: Actor,
  ids: readonly unknown[],
  purpose: UploadPurpose,
): Promise<AttachableUpload[]> {
  if (!can(actor, "upload.readStatus", { ownerId: actor.userId })) return [];
  const valid = [...new Set(ids.filter(isUuid))];
  if (valid.length === 0) return [];
  const rows = await db
    .select({ id: upload.id, status: upload.status })
    .from(upload)
    .where(
      and(
        inArray(upload.id, valid),
        eq(upload.userId, actor.userId),
        eq(upload.purpose, purpose),
      ),
    );
  return rows.flatMap((row) =>
    isUploadStatus(row.status) ? [{ id: row.id, status: row.status }] : [],
  );
}

// ---------------------------------------------------------------------------
// Viewing

/** What an authorizer learns about the upload it is asked about. */
export type ViewRequest = {
  uploadId: string;
  ownerId: string;
  purpose: UploadPurpose;
};

/**
 * Decides whether `actor` may view a clean upload. Called only after the
 * upload was found clean with the expected purpose, immediately before a URL
 * is issued, so an authorizer that records access (step 4b's document access
 * log) records only real views. Returning false refuses the view.
 */
export type ViewAuthorizer = (
  actor: Actor,
  request: ViewRequest,
) => boolean | Promise<boolean>;

/** The 4a rule: owners may view their own clean uploads. */
export const ownerMayView: ViewAuthorizer = (actor, request) =>
  can(actor, "upload.view", { ownerId: request.ownerId });

export type SignedUrlResult =
  | { ok: true; url: string; expiresInSeconds: number }
  | { ok: false; error: "not_found" };

/**
 * A presigned GET URL for a clean upload, valid for 5 minutes. Missing,
 * unfinished, rejected, wrong-purpose and unauthorized uploads all answer
 * `not_found`, so callers cannot probe for other users' uploads. The URL is
 * returned to the caller, never stored.
 */
export async function issueSignedUrl(
  deps: Pick<UploadDeps, "db" | "store" | "logger">,
  actor: Actor,
  input: {
    uploadId: unknown;
    purpose: UploadPurpose;
    authorize: ViewAuthorizer;
  },
): Promise<SignedUrlResult> {
  const notFound = { ok: false, error: "not_found" } as const;
  if (!isUuid(input.uploadId)) return notFound;
  const [row] = await deps.db
    .select({
      id: upload.id,
      userId: upload.userId,
      purpose: upload.purpose,
      status: upload.status,
      objectKey: upload.objectKey,
    })
    .from(upload)
    .where(eq(upload.id, input.uploadId))
    .limit(1);
  if (
    !row ||
    row.status !== "clean" ||
    !row.objectKey ||
    row.purpose !== input.purpose ||
    !isUploadPurpose(row.purpose)
  )
    return notFound;

  const allowed = await input.authorize(actor, {
    uploadId: row.id,
    ownerId: row.userId,
    purpose: row.purpose,
  });
  if (!allowed) return notFound;

  const url = await presignGet(
    deps.store,
    row.objectKey,
    SIGNED_URL_TTL_SECONDS,
    OUTPUT_TYPE,
  );
  deps.logger.info({
    event: "upload.url_issued",
    uploadId: row.id,
    actorId: actor.userId,
  });
  return { ok: true, url, expiresInSeconds: SIGNED_URL_TTL_SECONDS };
}
