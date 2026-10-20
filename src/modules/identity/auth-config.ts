import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { haveIBeenPwned } from "better-auth/plugins/haveibeenpwned";
import { twoFactor } from "better-auth/plugins/two-factor";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import type { EmailSender } from "@/shared/email/sender";
import type { AuthEmailKind } from "@/shared/email/templates";
import { dispatchAuthEmail } from "./auth-email";
import { consumeQuota, EMAIL_QUOTAS, emailLimiterKey } from "./rate-limit";
import { authSchema } from "./schema";

/** Better Auth API paths this product does not use; they answer 404. */
export const DISABLED_AUTH_PATHS = [
  "/update-user",
  "/update-session",
  "/change-email",
  "/change-password",
  "/delete-user",
  "/delete-user/callback",
  "/sign-in/social",
  "/link-social",
  "/unlink-account",
  "/list-accounts",
  "/account-info",
  "/get-access-token",
  "/refresh-token",
  "/verify-password",
];

// 2FA checks that create an MFA-verified session (see session hook below).
const MFA_SESSION_PATHS = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export type AuthDeps = {
  db: NodePgDatabase;
  emailSender: EmailSender;
  logger: Logger;
  secret: string;
  /** Public origin, e.g. https://example.com. Auth lives at `${appUrl}/api/auth`. */
  appUrl: string;
  breachedPasswordCheck: boolean;
  /** Defaults to true. Only tests that do not exercise limits turn it off. */
  rateLimitEnabled?: boolean;
};

export function createAuth(deps: AuthDeps) {
  const appUrl = deps.appUrl.replace(/\/$/, "");

  const emailDeps = {
    emailSender: deps.emailSender,
    logger: deps.logger,
    appUrl,
  };
  const dispatchEmail = (
    kind: AuthEmailKind,
    user: { id: string; email: string },
    path: string,
    params: Record<string, string>,
    request: Request | undefined,
  ) => dispatchAuthEmail(emailDeps, kind, user, path, params, request);

  return betterAuth({
    appName: "Pharmacist Platform",
    baseURL: appUrl,
    basePath: "/api/auth",
    secret: deps.secret,
    trustedOrigins: [appUrl],
    database: drizzleAdapter(deps.db, {
      provider: "pg",
      schema: authSchema,
      transaction: true,
    }),
    // Better Auth logs some events with email addresses at "info". Keep "warn"
    // and up, and pass only the message text: error objects can carry query
    // parameters.
    logger: {
      level: "warn",
      log(level, message, ...args) {
        const first = args[0];
        const errName = first instanceof Error ? first.name : undefined;
        deps.logger[level === "debug" ? "debug" : level](
          { event: "auth.library", errName },
          message,
        );
      },
    },
    disabledPaths: DISABLED_AUTH_PATHS,
    telemetry: { enabled: false },
    advanced: {
      database: { generateId: "uuid" },
      // Better Auth turns origin/CSRF checks off when NODE_ENV is "test".
      // Pin them on so every environment, including tests, behaves like
      // production.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      // Secure cookies follow APP_URL: https in production, http locally.
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      async sendResetPassword({ user, token }, request) {
        dispatchEmail(
          "passwordReset",
          user,
          "/reset-password",
          { token },
          request,
        );
      },
      // Duplicate sign-ups get the same response as new ones; the owner is
      // told by email instead. Sending mail on both paths also keeps timing
      // similar.
      async onExistingUserSignUp({ user }, request) {
        dispatchEmail("accountExists", user, "/sign-in", {}, request);
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      // An unverified user who signs in with the right password gets a fresh
      // link (still rate limited per IP and per email).
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      expiresIn: 24 * 60 * 60,
      async sendVerificationEmail({ user, token }, request) {
        dispatchEmail(
          "verification",
          user,
          "/verify-email",
          { token },
          request,
        );
      },
    },
    session: {
      expiresIn: 30 * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
      additionalFields: {
        mfaVerifiedAt: { type: "date", required: false, input: false },
      },
    },
    rateLimit: {
      enabled: deps.rateLimitEnabled ?? true,
      storage: "database",
      window: 60,
      max: 100,
      // Per IP (ADR-002). Two-factor endpoints keep the plugin's own rule
      // (3 per 10 s) plus its per-challenge and per-account lockouts.
      customRules: {
        "/sign-in/email": { window: 15 * 60, max: 5 },
        "/sign-up/email": { window: 60 * 60, max: 3 },
        "/request-password-reset": { window: 60 * 60, max: 3 },
        "/send-verification-email": { window: 60 * 60, max: 3 },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const rule = EMAIL_QUOTAS[ctx.path];
        if (!rule || deps.rateLimitEnabled === false) return;
        const email: unknown = ctx.body?.email;
        if (typeof email !== "string" || email.length === 0) return;
        const quota = await consumeQuota(
          deps.db,
          emailLimiterKey(deps.secret, ctx.path, email),
          rule,
        );
        if (!quota.allowed) {
          throw new APIError(
            "TOO_MANY_REQUESTS",
            { code: "RATE_LIMITED", message: "Too many requests." },
            { "X-Retry-After": String(quota.retryAfter) },
          );
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // Names live in profiles (ADR-003); never store client-supplied name/image.
          async before(user) {
            return { data: { ...user, name: "", image: null } };
          },
        },
      },
      session: {
        create: {
          // Mark sessions created by a passed 2FA check. Every other path
          // (password sign-in, trusted device, 2FA disable) gets null, even
          // when Better Auth copies fields from a previous session.
          async before(session, context) {
            const path = context?.path ?? "";
            return {
              data: {
                ...session,
                mfaVerifiedAt: MFA_SESSION_PATHS.has(path) ? new Date() : null,
              },
            };
          },
        },
      },
    },
    plugins: [
      twoFactor({
        issuer: "Pharmacist Platform",
      }),
      haveIBeenPwned({
        enabled: deps.breachedPasswordCheck,
        paths: ["/sign-up/email", "/reset-password"],
      }),
      // Must stay last: copies Set-Cookie into Next's cookie store when
      // auth.api is called from a server action.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
