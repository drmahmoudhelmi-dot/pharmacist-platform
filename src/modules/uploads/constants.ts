// Allowed values and limits for private uploads (ADR-004, 4a). Free of imports
// so the schema, policy, services, worker and UI can all share them.

/** Why a file was uploaded; decides who may later view it (4b plugs in reviewers). */
export const UPLOAD_PURPOSES = ["verification_document"] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

/**
 * `processing`: stored in quarantine, waiting for the scan and re-encode.
 * `clean`: scanned and re-encoded; the only state that can be viewed.
 * `rejected`: deleted from storage; `reject_reason` says why.
 */
export const UPLOAD_STATUSES = ["processing", "clean", "rejected"] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

/**
 * `infected`: clamd found a signature. `undecodable`: not a valid image (or a
 * decompression bomb). `processing_failed`: every retry failed (dead letter).
 */
export const REJECT_REASONS = [
  "infected",
  "undecodable",
  "processing_failed",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** Accepted on upload, detected from content. Stored output is always JPEG. */
export const ACCEPTED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
export type AcceptedType = (typeof ACCEPTED_TYPES)[number];
export const OUTPUT_TYPE = "image/jpeg";

export const UPLOAD_LIMITS = {
  /** Largest accepted file, in bytes (8 MiB). */
  maxBytes: 8 * 1024 * 1024,
  /** Room for multipart boundaries and the purpose field on top of the file. */
  multipartOverheadBytes: 64 * 1024,
  /** Uploads per user per hour, counted on every attempt. */
  hourly: { window: 60 * 60, max: 20 },
  /** Uploads per user that may wait in `processing` at once. */
  maxProcessingPerUser: 10,
  /** Output: longest side in pixels, JPEG quality. */
  maxLongSide: 2400,
  jpegQuality: 85,
  /** Decoder guard against decompression bombs (about 50 megapixels). */
  maxInputPixels: 50_000_000,
} as const;

/** Lifetime of a presigned view URL, in seconds (5 minutes). */
export const SIGNED_URL_TTL_SECONDS = 300;

export const QUARANTINE_PREFIX = "quarantine/";
export const DOCUMENTS_PREFIX = "documents/";

function includes<T extends string>(
  list: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (list as readonly string[]).includes(value)
  );
}

export const isUploadPurpose = (v: unknown): v is UploadPurpose =>
  includes(UPLOAD_PURPOSES, v);
export const isUploadStatus = (v: unknown): v is UploadStatus =>
  includes(UPLOAD_STATUSES, v);
export const isRejectReason = (v: unknown): v is RejectReason =>
  includes(REJECT_REASONS, v);
