import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/modules/identity/auth";

export const dynamic = "force-dynamic";

// Built lazily so `next build` does not need the runtime environment.
const handler = (request: Request) => getAuth().handler(request);

export const { GET, POST } = toNextJsHandler(handler);
