import { getActor } from "@/modules/identity/policy";
import { handleCreateUpload } from "@/modules/uploads/http";
import { getEnv } from "@/shared/config/env";
import { unavailable, uploadDeps } from "./deps";

// Private file upload (ADR-004, 4a). Keep /api out of the proxy matcher
// (src/proxy.ts): proxy buffers request bodies and truncates them at 10 MB.
export async function POST(request: Request) {
  try {
    const actor = await getActor();
    return await handleCreateUpload(
      await uploadDeps(),
      actor,
      request,
      getEnv().APP_URL,
    );
  } catch (error) {
    return unavailable(error);
  }
}
