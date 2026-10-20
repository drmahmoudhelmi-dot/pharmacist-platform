import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export type QuotaRule = { window: number; max: number };

/**
 * Per-email limits (ADR-002), on top of Better Auth's per-IP limits, so one
 * account cannot be hammered or mail-bombed from many addresses. Windows are
 * in seconds. They apply whether or not the email is registered, so a 429
 * reveals nothing about account existence.
 */
export const EMAIL_QUOTAS: Readonly<Record<string, QuotaRule>> = {
  "/sign-in/email": { window: 15 * 60, max: 10 },
  "/sign-up/email": { window: 60 * 60, max: 3 },
  "/request-password-reset": { window: 60 * 60, max: 3 },
  "/send-verification-email": { window: 60 * 60, max: 3 },
};

/**
 * Keyed hash of a normalized email, so the limiter never stores raw addresses
 * and the key cannot be reversed with a dictionary without the secret.
 */
export function emailLimiterKey(
  secret: string,
  path: string,
  email: string,
): string {
  const digest = createHmac("sha256", secret)
    .update(`rate-limit-email\u0000${email.trim().toLowerCase()}`)
    .digest("base64url");
  return `email|${path}|${digest}`;
}

/**
 * Atomically counts one request against `key` in a fixed window that starts at
 * the first request. One statement, so concurrent requests cannot both slip
 * under the limit. Uses Better Auth's `rate_limit` table (its own keys are
 * "ip|path", so they never collide); Better Auth prunes rows older than its
 * longest window (1 h), which is never shorter than these windows.
 */
export async function consumeQuota(
  db: NodePgDatabase,
  key: string,
  rule: QuotaRule,
  now: number = Date.now(),
): Promise<{ allowed: boolean; retryAfter: number }> {
  const windowStartCutoff = now - rule.window * 1000;
  const result = await db.execute<{ count: number; last_request: string }>(sql`
    insert into rate_limit (key, count, last_request)
    values (${key}, 1, ${now})
    on conflict (key) do update set
      count = case when rate_limit.last_request <= ${windowStartCutoff}
                   then 1 else rate_limit.count + 1 end,
      last_request = case when rate_limit.last_request <= ${windowStartCutoff}
                          then ${now} else rate_limit.last_request end
    returning count, last_request
  `);
  const row = result.rows[0];
  if (!row) throw new Error("rate limit upsert returned no row");
  const windowStart = Number(row.last_request);
  const allowed = row.count <= rule.max;
  const retryAfter = allowed
    ? 0
    : Math.max(1, Math.ceil((windowStart + rule.window * 1000 - now) / 1000));
  return { allowed, retryAfter };
}
