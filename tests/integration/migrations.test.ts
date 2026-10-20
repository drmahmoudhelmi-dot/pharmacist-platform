import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "@/shared/db/migrate";

describe("database migrations", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18-alpine").start();
    await runMigrations(container.getConnectionUri());
    pool = new Pool({ connectionString: container.getConnectionUri() });
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it("creates the drizzle migrations table and records the baseline", async () => {
    const table = await pool.query<{ exists: boolean }>(
      "select to_regclass('drizzle.__drizzle_migrations') is not null as exists",
    );
    expect(table.rows[0]?.exists).toBe(true);
    const applied = await pool.query(
      "select count(*)::int as n from drizzle.__drizzle_migrations",
    );
    expect(applied.rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it("runs queries against PostgreSQL 18", async () => {
    const result = await pool.query<{ one: number; major: string }>(
      "select 1 as one, current_setting('server_version_num')::int / 10000 as major",
    );
    expect(result.rows[0]?.one).toBe(1);
    expect(Number(result.rows[0]?.major)).toBe(18);
  });
});
