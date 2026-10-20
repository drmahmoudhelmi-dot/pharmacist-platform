import { existsSync } from "node:fs";
import { Pool } from "pg";

/**
 * Every E2E request comes from 127.0.0.1, so repeated local runs would hit the
 * real per-IP limits (sign-up: 3 per hour). Clear the local limiter table
 * before a run. Refuses to touch anything but a local database.
 */
export default async function globalSetup() {
  if (!process.env.DATABASE_URL && existsSync(".env"))
    process.loadEnvFile(".env");
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error("DATABASE_URL is not set; run `pnpm bootstrap` first.");
  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error("E2E setup only clears rate limits on a local database.");
  }
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query("delete from rate_limit");
  } finally {
    await pool.end();
  }
}
