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
    pool.on("error", () => {}); // see auth-harness.ts
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

  it("installs pg-boss in its own schema with the registry's queues", async () => {
    const queues = await pool.query<{
      name: string;
      dead_letter: string | null;
    }>("select name, dead_letter from pgboss.queue order by name");
    expect(queues.rows).toEqual([
      { name: "jobs.expire", dead_letter: null },
      { name: "jobs.notify", dead_letter: "jobs.notify.dead" },
      { name: "jobs.notify.dead", dead_letter: null },
      { name: "organization.notify", dead_letter: "organization.notify.dead" },
      { name: "organization.notify.dead", dead_letter: null },
      { name: "upload.process", dead_letter: "upload.process.dead" },
      { name: "upload.process.dead", dead_letter: null },
      { name: "verification.expire", dead_letter: null },
      { name: "verification.notify", dead_letter: "verification.notify.dead" },
      { name: "verification.notify.dead", dead_letter: null },
    ]);
  });

  it("is idempotent: running the migrations again changes nothing", async () => {
    await runMigrations(container.getConnectionUri());
    const queues = await pool.query(
      "select count(*)::int as n from pgboss.queue",
    );
    expect(queues.rows[0]?.n).toBe(10);
  });

  it("runs queries against PostgreSQL 18", async () => {
    const result = await pool.query<{ one: number; major: string }>(
      "select 1 as one, current_setting('server_version_num')::int / 10000 as major",
    );
    expect(result.rows[0]?.one).toBe(1);
    expect(Number(result.rows[0]?.major)).toBe(18);
  });
});
