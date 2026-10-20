// Security response headers (skill: references/security-privacy.md).
// Static headers are set for every path in next.config.ts; the CSP needs a
// per-request nonce and is set by src/proxy.ts on page responses.

export const STATIC_SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // Camera stays available to this origin for document capture (verification
  // step); everything else is off.
  {
    key: "Permissions-Policy",
    value:
      "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  // Ignored by browsers over plain http, so safe locally. No includeSubDomains
  // until the production domain layout is decided.
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
] as const;

/**
 * Nonce-based CSP. Next.js reads the nonce from the request's CSP header and
 * adds it to its own scripts, so no 'unsafe-inline' scripts and, outside
 * `next dev`, no 'unsafe-eval'. Pages must render dynamically for this.
 */
export function buildContentSecurityPolicy(
  nonce: string,
  isDevelopment: boolean,
): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDevelopment ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' ${isDevelopment ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** 128 random bits, base64. */
export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
