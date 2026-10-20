import "server-only";
import { getEnv } from "@/shared/config/env";
import { getDb } from "@/shared/db/client";
import { createSmtpSender } from "@/shared/email/smtp";
import { logger } from "@/shared/logging/logger";
import { type Auth, createAuth } from "./auth-config";

const globalForAuth = globalThis as unknown as { __auth?: Auth };

/**
 * The app's Better Auth instance, built on first use so `next build` needs no
 * environment. Cached on globalThis so dev hot reloads reuse it.
 */
export function getAuth(): Auth {
  if (!globalForAuth.__auth) {
    const env = getEnv();
    globalForAuth.__auth = createAuth({
      db: getDb(),
      emailSender: createSmtpSender({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        from: env.EMAIL_FROM,
      }),
      logger: logger.child({ module: "identity" }),
      secret: env.BETTER_AUTH_SECRET,
      appUrl: env.APP_URL,
      breachedPasswordCheck: env.AUTH_BREACHED_PASSWORD_CHECK,
    });
  }
  return globalForAuth.__auth;
}
