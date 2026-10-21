import { getActor } from "@/modules/identity/policy";
import { handleGetUploadStatus } from "@/modules/uploads/http";
import { getDb } from "@/shared/db/client";
import { unavailable } from "../deps";

// Upload status for its owner (ADR-004, 4a): status and reason code only.
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/uploads/[id]">,
) {
  try {
    const { id } = await ctx.params;
    return await handleGetUploadStatus({ db: getDb() }, await getActor(), id);
  } catch (error) {
    return unavailable(error);
  }
}
