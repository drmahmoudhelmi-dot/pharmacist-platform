import type { Actor } from "@/modules/identity/policy";
import { readUploadForm } from "./multipart";
import { can } from "./policy";
import {
  admitUpload,
  createUpload,
  getUploadStatus,
  type UploadDeps,
} from "./service";

// HTTP handling for the upload routes, kept out of src/app so the routes stay
// thin and integration tests can drive the real request path with a given
// Actor. Responses carry stable error codes (localized by the UI, "UploadErrors"
// in messages/*.json), never internal details, object keys or URLs.

export type UploadErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "invalid_request"
  | "too_large"
  | "unsupported_type"
  | "rate_limited"
  | "too_many_pending"
  | "not_found";

const STATUS: Record<UploadErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  invalid_request: 400,
  too_large: 413,
  unsupported_type: 415,
  rate_limited: 429,
  too_many_pending: 429,
  not_found: 404,
};

const NO_STORE = { "Cache-Control": "no-store" };

function error(code: UploadErrorCode, headers: Record<string, string> = {}) {
  return Response.json(
    { error: code },
    { status: STATUS[code], headers: { ...NO_STORE, ...headers } },
  );
}

/**
 * Cookie-authenticated mutation, so it must come from our own pages: the
 * Origin header (sent by browsers on every POST) must be the app's origin, or,
 * without one, Fetch Metadata must say same-origin. SameSite=Lax cookies
 * already stop cross-site form posts; this also covers same-site subdomains.
 */
export function isSameOrigin(request: Request, appUrl: string): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === new URL(appUrl).origin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

/** POST /api/uploads: multipart with one `file` and its `purpose`. */
export async function handleCreateUpload(
  deps: UploadDeps,
  actor: Actor | null,
  request: Request,
  appUrl: string,
): Promise<Response> {
  if (!actor) return error("unauthenticated");
  if (!isSameOrigin(request, appUrl)) return error("forbidden");
  if (!can(actor, "upload.create", { ownerId: actor.userId }))
    return error("forbidden");

  const admitted = await admitUpload(deps.db, actor);
  if (!admitted.ok)
    return error(
      admitted.error,
      admitted.retryAfter ? { "Retry-After": String(admitted.retryAfter) } : {},
    );

  const read = await readUploadForm(request);
  if (!read.ok) return error(read.error);

  const result = await createUpload(deps, actor, read.form);
  if (!result.ok) return error(result.error);
  return Response.json(result.upload, {
    status: 202,
    headers: { ...NO_STORE, Location: `/api/uploads/${result.upload.id}` },
  });
}

/** GET /api/uploads/:id: the owner's view of the status; 404 for anyone else. */
export async function handleGetUploadStatus(
  deps: Pick<UploadDeps, "db">,
  actor: Actor | null,
  id: string,
): Promise<Response> {
  if (!actor) return error("unauthenticated");
  const view = await getUploadStatus(deps.db, actor, id);
  if (!view) return error("not_found");
  return Response.json(view, { status: 200, headers: NO_STORE });
}
