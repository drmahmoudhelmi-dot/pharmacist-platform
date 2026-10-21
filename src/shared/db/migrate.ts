import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { installJobSchema } from "../jobs/boss";
import { createLogger } from "../logging/logger";

export const migrationsFolder = path.resolve(process.cwd(), "db/migrations");

/**
 * Applies the Drizzle migrations (schema `public`), then installs or upgrades
 * pg-boss's own schema (`pgboss`) and the job queues from the registry
 * (src/shared/jobs/registry.ts). Both steps are idempotent.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
  await installJobSchema(
    connectionString,
    createLogger({ base: { tool: "migrate" } }),
  );
}

// Run directly: `pnpm db:migrate` (tsx loads this file as the entry point).
const invokedDirectly = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(__filename)
  : false;

if (invokedDirectly) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (copy .env.example to .env).");
    process.exit(1);
  }
  runMigrations(url)
    .then(() => console.log("Migrations applied."))
    .catch((error: unknown) => {
      console.error(
        "Migration failed:",
        error instanceof Error ? error.message : "unknown error",
      );
      process.exit(1);
    });
}
