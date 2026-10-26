import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrationsFolder } from "@/shared/db/migrate";

// Migration 0007 (ADR-005 amendment) on data: applies 0000-0006, writes an
// admin membership, admin invitations and an admin audit row the way step 5
// could, then applies 0007 and checks the conversion.

describe("migration 0007: admin becomes recruiter", () => {
  let container: StartedPostgreSqlContainer;
  let pool: Pool;
  let upTo0006: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18-alpine").start();
    pool = new Pool({ connectionString: container.getConnectionUri() });
    pool.on("error", () => {}); // see auth-harness.ts
    upTo0006 = await mkdtemp(path.join(tmpdir(), "migrations-0006-"));
    await cp(migrationsFolder, upTo0006, { recursive: true });
    const journalPath = path.join(upTo0006, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: { idx: number }[];
    };
    journal.entries = journal.entries.filter((e) => e.idx <= 6);
    await writeFile(journalPath, JSON.stringify(journal));
    await migrate(drizzle(pool), { migrationsFolder: upTo0006 });
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
    if (upTo0006) await rm(upTo0006, { recursive: true, force: true });
  });

  it("converts admin memberships and invitations, keeps audit history", async () => {
    const q = (text: string, values: unknown[] = []) =>
      pool.query(text, values);
    const owner = (
      await q(
        `insert into "user" (name, email, email_verified) values ('', 'o@example.test', true) returning id`,
      )
    ).rows[0].id as string;
    const admin = (
      await q(
        `insert into "user" (name, email, email_verified) values ('', 'a@example.test', true) returning id`,
      )
    ).rows[0].id as string;
    const org = (
      await q(
        `insert into organization (kind, name, governorate_id, created_by) values ('pharmacy', 'صيدلية', 1, $1) returning id`,
        [owner],
      )
    ).rows[0].id as string;
    await q(
      `insert into organization_member (organization_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'admin')`,
      [org, owner, admin],
    );
    await q(
      `insert into organization_invitation (organization_id, email, role, status, expires_at, closed_at)
       values ($1, 'p@example.test', 'admin', 'pending', now() + interval '7 days', null),
              ($1, 'd@example.test', 'admin', 'declined', now() + interval '7 days', now())`,
      [org],
    );
    await q(
      `insert into organization_audit (organization_id, actor_id, action, role) values ($1, $2, 'invitation.accepted', 'admin')`,
      [org, admin],
    );

    await migrate(drizzle(pool), { migrationsFolder });

    const members = await q(
      `select role from organization_member where organization_id = $1 order by role`,
      [org],
    );
    expect(members.rows.map((r) => r.role)).toEqual(["owner", "recruiter"]);
    const invitations = await q(
      `select email, role, status from organization_invitation where organization_id = $1 order by email`,
      [org],
    );
    expect(invitations.rows).toEqual([
      { email: "d@example.test", role: "recruiter", status: "declined" },
      { email: "p@example.test", role: "recruiter", status: "pending" },
    ]);
    // History keeps the old role, and the audit CHECK still accepts it.
    const audit = await q(
      `select role from organization_audit where organization_id = $1`,
      [org],
    );
    expect(audit.rows).toEqual([{ role: "admin" }]);
    await q(
      `insert into organization_audit (organization_id, action, previous_role) values ($1, 'member.left', 'admin')`,
      [org],
    );
    // New admin rows are refused.
    await expect(
      q(
        `insert into organization_member (organization_id, user_id, role) values ($1, $2, 'admin') on conflict (organization_id, user_id) do update set role = 'admin'`,
        [org, admin],
      ),
    ).rejects.toThrow(/organization_member_role_check/);
  });
});
