import createMiddleware from "next-intl/middleware";
import { routing } from "@/shared/i18n/routing";

// Next.js 16 renamed `middleware.ts` to `proxy.ts`.
export default createMiddleware(routing);

export const config = {
  // Skip API routes, Next internals and anything with a file extension.
  matcher: ["/((?!api|_next|.*\\..*).*)"],
};
