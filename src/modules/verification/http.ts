import type { Actor } from "@/modules/identity/policy";
import type { UploadDeps } from "@/modules/uploads/service";
import { normalizeIp, viewDocument } from "./service";

// HTTP handling for the reviewer's document route, kept out of src/app so the
// route stays thin and integration tests drive the real request path.

const NO_STORE = {
  "Cache-Control": "no-store",
  // The signed URL and this page's address never travel in a Referer header.
  "Referrer-Policy": "no-referrer",
};

function error(status: 401 | 403 | 404, code: string) {
  return Response.json({ error: code }, { status, headers: NO_STORE });
}

/**
 * GET /api/verification/documents/:id → 303 to a fresh 5-minute signed URL.
 * Each call writes one `view` row in document_access_log before the URL is
 * issued. Anything but an authorized reviewer on a pending submission gets
 * 404 (401 without a session). Only same-origin requests: the staff page's
 * own <img> tags (Fetch Metadata), not links from elsewhere.
 */
export async function handleViewDocument(
  deps: Pick<UploadDeps, "db" | "store" | "logger">,
  actor: Actor | null,
  documentId: string,
  request: Request,
): Promise<Response> {
  if (!actor) return error(401, "unauthenticated");
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return error(403, "forbidden");
  const result = await viewDocument(
    deps,
    actor,
    documentId,
    normalizeIp(request.headers.get("x-forwarded-for")),
  );
  if (!result.ok) return error(404, "not_found");
  return new Response(null, {
    status: 303,
    headers: { ...NO_STORE, Location: result.url },
  });
}
