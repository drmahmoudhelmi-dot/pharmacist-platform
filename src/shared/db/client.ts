import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getEnv } from "@/shared/config/env";

// Cached on globalThis so Next.js dev hot reloads do not leak pools.
const globalForDb = globalThis as unknown as { __pgPool?: Pool };

export function getPool(): Pool {
  globalForDb.__pgPool ??= new Pool({
    connectionString: getEnv().DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 3000,
  });
  return globalForDb.__pgPool;
}

export function getDb() {
  return drizzle(getPool());
}
