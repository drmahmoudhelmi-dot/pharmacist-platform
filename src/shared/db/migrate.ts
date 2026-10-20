import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

export const migrationsFolder = path.resolve(process.cwd(), "db/migrations");

export async function runMigrations(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
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
