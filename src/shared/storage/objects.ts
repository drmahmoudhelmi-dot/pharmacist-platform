import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Small object-storage helpers over the S3 API (MinIO locally). Callers pass
// the client and bucket, so the worker and tests can use their own.

export type ObjectStore = { s3: S3Client; bucket: string };

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === "NoSuchKey" ||
    e.name === "NotFound" ||
    e.$metadata?.httpStatusCode === 404
  );
}

export async function putObject(
  store: ObjectStore,
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  await store.s3.send(
    new PutObjectCommand({
      Bucket: store.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ContentLength: body.byteLength,
    }),
  );
}

/** The object's bytes, or null when it does not exist. Throws above `maxBytes`. */
export async function getObjectBytes(
  store: ObjectStore,
  key: string,
  maxBytes: number,
): Promise<Uint8Array | null> {
  try {
    const result = await store.s3.send(
      new GetObjectCommand({ Bucket: store.bucket, Key: key }),
    );
    if (!result.Body) throw new Error("stored object has no body");
    if ((result.ContentLength ?? 0) > maxBytes) {
      // Release the connection without reading the body.
      (result.Body as { destroy?: () => void }).destroy?.();
      throw new Error("stored object is larger than allowed");
    }
    const bytes = await result.Body.transformToByteArray();
    if (bytes.byteLength > maxBytes)
      throw new Error("stored object is larger than allowed");
    return bytes;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function objectExists(
  store: ObjectStore,
  key: string,
): Promise<boolean> {
  try {
    await store.s3.send(
      new HeadObjectCommand({ Bucket: store.bucket, Key: key }),
    );
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** Deletes an object. Deleting a missing key succeeds (S3 semantics). */
export async function deleteObject(
  store: ObjectStore,
  key: string,
): Promise<void> {
  await store.s3.send(
    new DeleteObjectCommand({ Bucket: store.bucket, Key: key }),
  );
}

/**
 * A presigned GET URL valid for `expiresInSeconds`. Storage serves the object
 * inline with the given type and tells caches not to store it.
 */
export async function presignGet(
  store: ObjectStore,
  key: string,
  expiresInSeconds: number,
  contentType: string,
  /** Tests only: sign as of another time to check expiry. */
  signingDate?: Date,
): Promise<string> {
  return getSignedUrl(
    store.s3,
    new GetObjectCommand({
      Bucket: store.bucket,
      Key: key,
      ResponseContentType: contentType,
      ResponseContentDisposition: "inline",
      ResponseCacheControl: "private, no-store",
    }),
    { expiresIn: expiresInSeconds, signingDate },
  );
}
