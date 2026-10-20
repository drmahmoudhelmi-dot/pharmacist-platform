import createMiddleware from "next-intl/middleware";
import { NextRequest } from "next/server";
import { routing } from "@/shared/i18n/routing";
import {
  buildContentSecurityPolicy,
  createNonce,
} from "@/shared/security/headers";

// Next.js 16 renamed `middleware.ts` to `proxy.ts`.
const handleI18nRouting = createMiddleware(routing);

export default function proxy(request: NextRequest) {
  const nonce = createNonce();
  const csp = buildContentSecurityPolicy(
    nonce,
    process.env.NODE_ENV === "development",
  );
  // Next.js takes the nonce for its own scripts from the request's CSP header.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = handleI18nRouting(
    new NextRequest(request, { headers: requestHeaders }),
  );
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Skip API routes, Next internals and anything with a file extension.
  matcher: ["/((?!api|_next|.*\\..*).*)"],
};
