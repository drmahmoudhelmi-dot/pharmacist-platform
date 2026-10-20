// Browser-side calls to the Better Auth HTTP API (/api/auth/*). Going through
// HTTP, not server actions, keeps Better Auth's per-IP rate limits and origin
// (CSRF) checks in the path. Results carry only a stable error key for
// localized messages; library message text is never shown.

export type AuthErrorKey =
  | "invalidCredentials"
  | "emailNotVerified"
  | "invalidEmail"
  | "passwordTooShort"
  | "passwordTooLong"
  | "passwordCompromised"
  | "invalidToken"
  | "invalidCode"
  | "invalidBackupCode"
  | "twoFactorExpired"
  | "twoFactorTooManyAttempts"
  | "accountLocked"
  | "wrongPassword"
  | "sessionNotFresh"
  | "totpAlreadyEnabled"
  | "unauthenticated"
  | "rateLimited"
  | "network"
  | "generic";

const CODE_TO_KEY: Record<string, AuthErrorKey> = {
  INVALID_EMAIL_OR_PASSWORD: "invalidCredentials",
  EMAIL_NOT_VERIFIED: "emailNotVerified",
  INVALID_EMAIL: "invalidEmail",
  PASSWORD_TOO_SHORT: "passwordTooShort",
  PASSWORD_TOO_LONG: "passwordTooLong",
  PASSWORD_COMPROMISED: "passwordCompromised",
  INVALID_TOKEN: "invalidToken",
  TOKEN_EXPIRED: "invalidToken",
  INVALID_CODE: "invalidCode",
  INVALID_BACKUP_CODE: "invalidBackupCode",
  INVALID_TWO_FACTOR_COOKIE: "twoFactorExpired",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "twoFactorTooManyAttempts",
  ACCOUNT_TEMPORARILY_LOCKED: "accountLocked",
  INVALID_PASSWORD: "wrongPassword",
  SESSION_NOT_FRESH: "sessionNotFresh",
  TOTP_ALREADY_ENABLED: "totpAlreadyEnabled",
  RATE_LIMITED: "rateLimited",
};

export function toErrorKey(status: number, code: unknown): AuthErrorKey {
  if (status === 429) return "rateLimited";
  if (typeof code === "string" && Object.hasOwn(CODE_TO_KEY, code)) {
    return CODE_TO_KEY[code] as AuthErrorKey;
  }
  if (status === 401) return "unauthenticated";
  return "generic";
}

export type AuthResult<T> =
  { ok: true; data: T } | { ok: false; error: AuthErrorKey };

export async function authPost<T = unknown>(
  path: string,
  body: Record<string, unknown>,
  locale: string,
): Promise<AuthResult<T>> {
  let response: Response;
  try {
    response = await fetch(`/api/auth${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        // Read by the server to pick the email language.
        "x-app-locale": locale,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, error: "network" };
  }
  const json: unknown = await response.json().catch(() => null);
  if (response.ok) return { ok: true, data: json as T };
  const code =
    json && typeof json === "object" && "code" in json ? json.code : undefined;
  return { ok: false, error: toErrorKey(response.status, code) };
}
