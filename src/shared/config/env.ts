import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_PRIVATE_BUCKET: z.string().min(1),
  S3_PUBLIC_BUCKET: z.string().min(1),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  APP_URL: z.url(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates a raw environment. Error messages list only the offending keys,
 * never their values, so secrets cannot leak into logs.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const keys = [
      ...new Set(result.error.issues.map((issue) => String(issue.path[0]))),
    ].sort();
    throw new Error(
      `Invalid or missing environment variables: ${keys.join(", ")}`,
    );
  }
  return result.data;
}

let cached: Env | undefined;

/**
 * Lazy so that `next build` and tooling that imports this module do not need
 * a populated environment. Validation runs on first use at runtime.
 */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
