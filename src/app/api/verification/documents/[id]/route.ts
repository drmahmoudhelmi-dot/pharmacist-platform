import { getActor } from "@/modules/identity/policy";
import { documentDeps, verificationLogger } from "@/modules/verification/deps";
import { handleViewDocument } from "@/modules/verification/http";

// A reviewer's view of one verification document (ADR-004, 4b): logs the view,
// then redirects to a short-lived signed URL. Never cached.
export async function GET(
  request: Request,
  ctx: RouteContext<"/api/verification/documents/[id]">,
) {
  try {
    const { id } = await ctx.params;
    return await handleViewDocument(
      documentDeps(),
      await getActor(),
      id,
      request,
    );
  } catch (error) {
    verificationLogger.error(
      { err: error, event: "verification.document_view_failed" },
      "document view failed",
    );
    return Response.json(
      { error: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
