import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import sharp from "sharp";
import type { ScanResult } from "@/shared/av/clamd";
import {
  deleteObject,
  getObjectBytes,
  type ObjectStore,
  putObject,
} from "@/shared/storage/objects";
import {
  DOCUMENTS_PREFIX,
  OUTPUT_TYPE,
  QUARANTINE_PREFIX,
  type RejectReason,
  UPLOAD_LIMITS,
} from "./constants";
import { upload } from "./schema";

// The worker side of the upload pipeline (ADR-004, 4a): the `upload.process`
// job and its dead-letter handler. Runs in `pnpm worker`, not in the web app,
// so it does not import "server-only".
//
// Idempotent: every step can be repeated after a crash or a retry.
//   1. Row missing or no longer `processing` → nothing to do.
//   2. Quarantine object gone → a previous attempt stored the output and
//      deleted the quarantine copy but did not mark the row; finish that.
//   3. Scan (clamd errors throw, so pg-boss retries with backoff).
//   4. Re-encode; write the output under a key derived from the quarantine
//      key, so a repeat overwrites the same object with the same bytes.
//   5. Delete the quarantine object, then mark the row clean (only from
//      `processing`, so a concurrent dead-letter decision wins cleanly).

type Db = NodePgDatabase;

export type ProcessDeps = {
  db: Db;
  store: ObjectStore;
  scan: (bytes: Uint8Array) => Promise<ScanResult>;
  logger: Logger;
};

export type ProcessOutcome = "clean" | "rejected" | "skipped";

type StoreDeps = Omit<ProcessDeps, "scan">;

type Row = { id: string; quarantineKey: string };

/** `quarantine/<uuid>` → `documents/<uuid>.jpg` (both random, never user input). */
export function outputKeyFor(quarantineKey: string): string {
  if (!quarantineKey.startsWith(QUARANTINE_PREFIX))
    throw new Error("unexpected quarantine key");
  return `${DOCUMENTS_PREFIX}${quarantineKey.slice(QUARANTINE_PREFIX.length)}.jpg`;
}

/**
 * Decodes any accepted image and writes a fresh JPEG: orientation applied
 * from EXIF, longest side at most 2,400 px, transparency flattened onto white,
 * and no metadata at all (sharp drops EXIF, GPS, XMP, IPTC and ICC unless
 * asked to keep them). Throws when the input is not a decodable image or is
 * larger than the pixel limit (decompression bombs).
 */
export async function reencodeImage(input: Uint8Array): Promise<Uint8Array> {
  const output = await sharp(input, {
    limitInputPixels: UPLOAD_LIMITS.maxInputPixels,
    failOn: "warning",
  })
    .rotate()
    .resize({
      width: UPLOAD_LIMITS.maxLongSide,
      height: UPLOAD_LIMITS.maxLongSide,
      fit: "inside",
      withoutEnlargement: true,
    })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: UPLOAD_LIMITS.jpegQuality, mozjpeg: true })
    .toBuffer();
  if (output.byteLength === 0 || output.byteLength > UPLOAD_LIMITS.maxBytes)
    throw new Error("re-encoded image outside the size limit");
  return new Uint8Array(output);
}

const sha256Hex = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function loadProcessing(db: Db, uploadId: string): Promise<Row | null> {
  const [row] = await db
    .select({
      id: upload.id,
      status: upload.status,
      quarantineKey: upload.quarantineKey,
    })
    .from(upload)
    .where(eq(upload.id, uploadId))
    .limit(1);
  return row && row.status === "processing" ? row : null;
}

async function markClean(
  deps: StoreDeps,
  row: Row,
  outputKey: string,
  output: Uint8Array,
): Promise<ProcessOutcome> {
  const updated = await deps.db
    .update(upload)
    .set({
      status: "clean",
      objectKey: outputKey,
      sha256: sha256Hex(output),
      contentType: OUTPUT_TYPE,
      byteSize: output.byteLength,
      updatedAt: new Date(),
    })
    .where(and(eq(upload.id, row.id), eq(upload.status, "processing")))
    .returning({ id: upload.id });
  if (updated.length === 1) {
    deps.logger.info({ event: "upload.clean", uploadId: row.id });
    return "clean";
  }
  // The row changed under us: another attempt finished first (then the object
  // is its output, keep it), or it was rejected or deleted (then the object is
  // an orphan, remove it).
  const [now] = await deps.db
    .select({ status: upload.status, objectKey: upload.objectKey })
    .from(upload)
    .where(eq(upload.id, row.id))
    .limit(1);
  if (!(now?.status === "clean" && now.objectKey === outputKey))
    await deleteObject(deps.store, outputKey);
  return "skipped";
}

async function markRejected(
  deps: StoreDeps,
  row: Row,
  reason: RejectReason,
): Promise<ProcessOutcome> {
  await deps.db
    .update(upload)
    .set({ status: "rejected", rejectReason: reason, updatedAt: new Date() })
    .where(and(eq(upload.id, row.id), eq(upload.status, "processing")));
  deps.logger.warn({ event: "upload.rejected", uploadId: row.id, reason });
  return "rejected";
}

/** The `upload.process` job. Throws only for errors worth retrying. */
export async function processUpload(
  deps: ProcessDeps,
  uploadId: string,
): Promise<ProcessOutcome> {
  const row = await loadProcessing(deps.db, uploadId);
  if (!row) {
    deps.logger.info({ event: "upload.process_skipped", uploadId });
    return "skipped";
  }
  const outputKey = outputKeyFor(row.quarantineKey);
  const limit = UPLOAD_LIMITS.maxBytes;

  const original = await getObjectBytes(deps.store, row.quarantineKey, limit);
  if (!original) {
    const output = await getObjectBytes(deps.store, outputKey, limit);
    if (output) return markClean(deps, row, outputKey, output);
    // Neither copy exists: the file is lost and cannot be processed.
    return markRejected(deps, row, "processing_failed");
  }

  const verdict = await deps.scan(original);
  if (verdict.infected) {
    // The signature name identifies malware, not a person; safe to log.
    deps.logger.warn({
      event: "upload.infected",
      uploadId: row.id,
      signature: verdict.signature,
    });
    await deleteObject(deps.store, row.quarantineKey);
    return markRejected(deps, row, "infected");
  }

  let output: Uint8Array;
  try {
    output = await reencodeImage(original);
  } catch {
    await deleteObject(deps.store, row.quarantineKey);
    return markRejected(deps, row, "undecodable");
  }

  await putObject(deps.store, outputKey, output, OUTPUT_TYPE);
  await deleteObject(deps.store, row.quarantineKey);
  return markClean(deps, row, outputKey, output);
}

/**
 * The dead-letter handler: every attempt of `upload.process` failed. Removes
 * both possible objects and marks the upload rejected, so it stops counting
 * against the user's processing cap and they can try again.
 */
export async function failUpload(
  deps: StoreDeps,
  uploadId: string,
): Promise<ProcessOutcome> {
  const row = await loadProcessing(deps.db, uploadId);
  if (!row) return "skipped";
  await deleteObject(deps.store, outputKeyFor(row.quarantineKey));
  await deleteObject(deps.store, row.quarantineKey);
  deps.logger.error({ event: "upload.processing_failed", uploadId: row.id });
  return markRejected(deps, row, "processing_failed");
}
