import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordAudit } from "@/modules/admin/audit";
import { AUDIT_PAGE_SIZE } from "@/modules/admin/constants";
import {
  changeStaffRole,
  listStaff,
  searchAudit,
} from "@/modules/admin/service";
import { actorFromSession, type Actor } from "@/modules/identity/policy";
import { changeRole, listRoles } from "@/modules/identity/roles-service";
import { decideJob } from "@/modules/jobs/service";
import { createClientBoss, type PgBoss } from "@/shared/jobs/boss";
import { createLogger } from "@/shared/logging/logger";
import {
  type CookieJar,
  type Harness,
  startHarness,
} from "./helpers/auth-harness";
import { fixtures, PASSWORD } from "./helpers/fixtures";
import { totpFromUri } from "./helpers/totp";

// Admin audit log, staff role management and TOTP replay protection
// (ADR-008) against real PostgreSQL. Staff actors are real Better Auth
// accounts whose sessions passed TOTP. Synthetic data only.

let h: Harness;
let boss: PgBoss;
let f: ReturnType<typeof fixtures>;
const logger = createLogger(
  { level: "silent" },
  new Writable({ write: (_c, _e, done) => done() }),
);
let counter = 0;

type Staff = { email: string; actor: Actor; jar: CookieJar; uri: string };

async function sessionActor(jar: CookieJar): Promise<Actor> {
  const current = await h.call("/get-session", { jar });
  const session = current.json as unknown as Parameters<
    typeof actorFromSession
  >[0];
  return actorFromSession(session, await listRoles(h.db, session.user.id));
}

/** A verified account with TOTP enabled and a session that passed it. */
async function withTotp(label: string, role?: "super_admin" | "moderator") {
  counter += 1;
  const email = `${label}-${counter}@example.test`;
  await h.createVerifiedUser(email, PASSWORD);
  if (role) await changeRole(h.db, { email, role, change: "grant" });
  const { jar } = await h.signIn(email, PASSWORD);
  const enable = await h.call("/two-factor/enable", {
    body: { password: PASSWORD },
    jar,
  });
  const uri = enable.json?.totpURI as string;
  const verified = await h.call("/two-factor/verify-totp", {
    body: { code: totpFromUri(uri) },
    jar,
  });
  expect(verified.status).toBe(200);
  return { email, jar, uri, actor: await sessionActor(jar) } satisfies Staff;
}

async function auditRows(targetId: string) {
  const result = await h.pool.query(
    "select actor_id, actor_kind, action, target_type, detail, ip from admin_audit where target_id = $1 order by at, id",
    [targetId],
  );
  return result.rows;
}

/** Waits for a fresh 30-second step when the current one is nearly over. */
async function freshStep() {
  const into = Date.now() % 30_000;
  if (into > 20_000)
    await new Promise((resolve) => setTimeout(resolve, 30_000 - into + 200));
}

beforeAll(async () => {
  h = await startHarness();
  boss = createClientBoss((text, values) => h.pool.query(text, values), logger);
  await boss.start();
  f = fixtures(h, boss);
});

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await h?.stop();
});

describe("staff role management", () => {
  it("grants and revokes for super admins, revoking sessions and auditing each change", async () => {
    const admin = await withTotp("admin", "super_admin");
    const target = await f.person("future-reviewer");

    expect(
      await changeStaffRole(
        h.db,
        admin.actor,
        {
          email: target.email.toUpperCase(),
          role: "verification_reviewer",
          change: "grant",
        },
        "203.0.113.9",
      ),
    ).toEqual({ ok: true, status: "granted" });
    // The target's sessions were revoked with the change.
    expect((await h.call("/get-session", { jar: target.jar })).json).toBeNull();
    expect(await listRoles(h.db, target.actor.userId)).toEqual([
      "verification_reviewer",
    ]);
    // Granting again changes nothing and writes nothing.
    expect(
      await changeStaffRole(h.db, admin.actor, {
        email: target.email,
        role: "verification_reviewer",
        change: "grant",
      }),
    ).toEqual({ ok: true, status: "unchanged" });

    const listed = await listStaff(h.db, admin.actor);
    const row = listed.find((a) => a.userId === target.actor.userId);
    expect(row?.isSelf).toBe(false);
    expect(row?.roles).toEqual([
      expect.objectContaining({
        role: "verification_reviewer",
        grantedBy: admin.actor.userId,
        grantedByEmail: admin.email,
      }),
    ]);
    expect(listed.find((a) => a.userId === admin.actor.userId)?.isSelf).toBe(
      true,
    );

    expect(
      await changeStaffRole(h.db, admin.actor, {
        email: target.email,
        role: "verification_reviewer",
        change: "revoke",
      }),
    ).toEqual({ ok: true, status: "revoked" });
    expect(await listRoles(h.db, target.actor.userId)).toEqual([]);

    expect(await auditRows(target.actor.userId)).toEqual([
      {
        actor_id: admin.actor.userId,
        actor_kind: "staff",
        action: "role.granted",
        target_type: "user",
        detail: { role: "verification_reviewer" },
        ip: "203.0.113.9",
      },
      {
        actor_id: admin.actor.userId,
        actor_kind: "staff",
        action: "role.revoked",
        target_type: "user",
        detail: { role: "verification_reviewer" },
        ip: null,
      },
    ]);
  });

  it("audits the operator command line as an operator action", async () => {
    const target = await f.person("cli-target");
    const result = await changeRole(h.db, {
      email: target.email,
      role: "support",
      change: "grant",
    });
    expect(result.status).toBe("granted");
    expect(await auditRows(target.actor.userId)).toEqual([
      {
        actor_id: null,
        actor_kind: "operator",
        action: "role.granted",
        target_type: "user",
        detail: { role: "support" },
        ip: null,
      },
    ]);
  });

  it("refuses non super admins, invalid input, unknown and unverified accounts", async () => {
    const admin = await withTotp("admin-checks", "super_admin");
    const moderator = await withTotp("mod-checks", "moderator");
    const target = await f.person("checks-target");

    const grant = {
      email: target.email,
      role: "support",
      change: "grant",
    } as const;
    expect(await changeStaffRole(h.db, moderator.actor, grant)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await changeStaffRole(h.db, target.actor, grant)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await listStaff(h.db, moderator.actor)).toEqual([]);
    // A super admin whose session did not pass TOTP is refused too.
    const noMfa = { ...admin.actor, mfaSatisfied: false };
    expect(await changeStaffRole(h.db, noMfa, grant)).toEqual({
      ok: false,
      error: "forbidden",
    });

    expect(
      await changeStaffRole(h.db, admin.actor, { ...grant, role: "owner" }),
    ).toEqual({ ok: false, error: "validation" });
    expect(
      await changeStaffRole(h.db, admin.actor, {
        ...grant,
        email: "not-an-email",
      }),
    ).toEqual({ ok: false, error: "validation" });
    expect(
      await changeStaffRole(h.db, admin.actor, {
        ...grant,
        email: "nobody-here@example.test",
      }),
    ).toEqual({ ok: false, error: "userNotFound" });

    counter += 1;
    const unverified = `unverified-${counter}@example.test`;
    await h.signUp(unverified, PASSWORD);
    expect(
      await changeStaffRole(h.db, admin.actor, { ...grant, email: unverified }),
    ).toEqual({ ok: false, error: "emailNotVerified" });

    expect(await auditRows(target.actor.userId)).toEqual([]);
  });

  it("never lets anyone change their own roles, and keeps the last super admin", async () => {
    // A clean slate for the super admin count: revoke every existing one.
    await h.pool.query("delete from user_role where role = 'super_admin'");
    const admin = await withTotp("only-admin", "super_admin");

    expect(
      await changeStaffRole(h.db, admin.actor, {
        email: admin.email,
        role: "moderator",
        change: "grant",
      }),
    ).toEqual({ ok: false, error: "selfChange" });
    expect(
      await changeStaffRole(h.db, admin.actor, {
        email: admin.email,
        role: "super_admin",
        change: "revoke",
      }),
    ).toEqual({ ok: false, error: "selfChange" });

    // Two super admins: each may revoke the other, but not both at once. The
    // second request finds its own actor revoked under the lock (so the
    // last-super-admin count is a second line of defence).
    const second = await withTotp("second-admin", "super_admin");
    const results = await Promise.all([
      changeStaffRole(h.db, admin.actor, {
        email: second.email,
        role: "super_admin",
        change: "revoke",
      }),
      changeStaffRole(h.db, second.actor, {
        email: admin.email,
        role: "super_admin",
        change: "revoke",
      }),
    ]);
    expect(results).toEqual(
      expect.arrayContaining([
        { ok: true, status: "revoked" },
        { ok: false, error: "forbidden" },
      ]),
    );
    const remaining = await h.pool.query(
      "select count(*)::int as n from user_role where role = 'super_admin'",
    );
    expect(remaining.rows[0].n).toBe(1);
    expect(await auditRows(admin.actor.userId)).toHaveLength(
      results[1]?.ok ? 2 : 1,
    );
  });
});

describe("a revoked super admin", () => {
  it("cannot change roles with a request built from their old session", async () => {
    const admin = await withTotp("revoked-admin", "super_admin");
    await withTotp("other-admin", "super_admin");
    const target = await f.person("stale-target");
    await changeRole(h.db, {
      email: admin.email,
      role: "super_admin",
      change: "revoke",
    });
    // admin.actor still carries super_admin, as an in-flight request would.
    expect(
      await changeStaffRole(h.db, admin.actor, {
        email: target.email,
        role: "super_admin",
        change: "grant",
      }),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(await listRoles(h.db, target.actor.userId)).toEqual([]);
  });
});

describe("audit trail of staff decisions", () => {
  it("records job moderation in the decision's transaction", async () => {
    const { jobId } = await f.publishedJob();
    const rows = await auditRows(jobId);
    expect(rows).toEqual([
      expect.objectContaining({
        actor_kind: "staff",
        action: "job.moderated",
        target_type: "job",
        detail: expect.objectContaining({ decision: "approved" }),
      }),
    ]);
    // A refused decision leaves no row.
    const mod = await f.moderator();
    const again = await decideJob({ db: h.db, boss }, mod.actor, jobId, {
      decision: "approved",
    });
    expect(again.ok).toBe(false);
    expect(await auditRows(jobId)).toHaveLength(1);
  });

  it("refuses details outside the action's schema, so nothing personal gets in", async () => {
    const target = await f.person("detail");
    await expect(
      recordAudit(h.db, {
        actorId: null,
        actorKind: "system",
        action: "role.granted",
        targetType: "user",
        targetId: target.actor.userId,
        detail: { role: "support", email: target.email },
      }),
    ).rejects.toThrow();
    await expect(
      recordAudit(h.db, {
        actorId: null,
        actorKind: "system",
        action: "verification.decided",
        targetType: "verification_submission",
        targetId: target.actor.userId,
        detail: { decision: "rejected", reasonCode: "سامي فريد" },
      }),
    ).rejects.toThrow();
    expect(await auditRows(target.actor.userId)).toEqual([]);
  });

  it("is append-only: no update, delete or truncate, but survives the actor's deletion", async () => {
    const admin = await withTotp("append-admin", "super_admin");
    const target = await f.person("append-target");
    await changeStaffRole(h.db, admin.actor, {
      email: target.email,
      role: "support",
      change: "grant",
    });
    await expect(
      h.pool.query(
        "update admin_audit set detail = '{}'::jsonb where target_id = $1",
        [target.actor.userId],
      ),
    ).rejects.toThrow();
    await expect(
      h.pool.query("delete from admin_audit where target_id = $1", [
        target.actor.userId,
      ]),
    ).rejects.toThrow();
    await expect(h.pool.query("truncate admin_audit")).rejects.toThrow();
    await expect(
      h.pool.query(
        "insert into admin_audit (actor_kind, action, target_type, target_id, detail) values ('staff', 'role.granted', 'user', $1, '[]'::jsonb)",
        [target.actor.userId],
      ),
    ).rejects.toThrow();

    // Deleting the acting account keeps the row, with the actor nulled.
    await h.pool.query('delete from "user" where id = $1', [
      admin.actor.userId,
    ]);
    expect(await auditRows(target.actor.userId)).toEqual([
      expect.objectContaining({ actor_id: null, action: "role.granted" }),
    ]);
  });
});

describe("audit viewer", () => {
  it("shows super admins the log newest first, filtered and paged; nobody else", async () => {
    const admin = await withTotp("viewer-admin", "super_admin");
    const target = await f.person("paged");
    const base = Date.now() - 3_600_000;
    for (let i = 0; i < AUDIT_PAGE_SIZE + 5; i += 1)
      await recordAudit(h.db, {
        actorId: admin.actor.userId,
        actorKind: "staff",
        action: i % 2 === 0 ? "role.granted" : "role.revoked",
        targetType: "user",
        targetId: target.actor.userId,
        detail: { role: "support" },
        // Most rows take the column default (as every real writer does);
        // the rest share timestamps, so paging must break ties by id.
        ...(i < 30 ? {} : { at: new Date(base + Math.floor(i / 3) * 1000) }),
      });

    const first = await searchAudit(h.db, admin.actor, {
      targetId: target.actor.userId,
    });
    expect(first.items).toHaveLength(AUDIT_PAGE_SIZE);
    expect(first.items[0]).toMatchObject({
      actorEmail: admin.email,
      actorKind: "staff",
      targetType: "user",
      targetId: target.actor.userId,
      detail: { role: "support" },
    });
    expect(first.nextCursor).not.toBeNull();
    const second = await searchAudit(h.db, admin.actor, {
      targetId: target.actor.userId,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const all = [...first.items, ...second.items];
    expect(new Set(all.map((e) => e.id)).size).toBe(AUDIT_PAGE_SIZE + 5);
    const times = all.map((e) => e.at);
    expect(times).toEqual([...times].sort().reverse());

    const revoked = await searchAudit(h.db, admin.actor, {
      targetId: target.actor.userId,
      action: "role.revoked",
    });
    expect(revoked.items).toHaveLength(Math.floor((AUDIT_PAGE_SIZE + 5) / 2));
    expect(revoked.items.every((e) => e.action === "role.revoked")).toBe(true);

    const byActor = await searchAudit(h.db, admin.actor, {
      actorEmail: admin.email.toUpperCase(),
      targetType: "user",
    });
    expect(byActor.items.length).toBeGreaterThan(0);
    expect(byActor.items.every((e) => e.actorEmail === admin.email)).toBe(true);
    expect(
      (
        await searchAudit(h.db, admin.actor, {
          actorEmail: "nobody-here@example.test",
        })
      ).items,
    ).toEqual([]);
    // Invalid filters and cursors are ignored, not errors.
    const lenient = await searchAudit(h.db, admin.actor, {
      action: "drop table",
      targetType: "nope",
      targetId: "1 or 1=1",
      cursor: "!!!",
    });
    expect(lenient.items).toHaveLength(AUDIT_PAGE_SIZE);

    const moderator = await withTotp("viewer-mod", "moderator");
    expect(await searchAudit(h.db, moderator.actor)).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(
      await searchAudit(h.db, { ...admin.actor, mfaSatisfied: false }),
    ).toEqual({ items: [], nextCursor: null });
  });
});

describe("TOTP replay protection", () => {
  it("accepts a code once; a refused attempt does not spend it", async () => {
    await freshStep();
    const a = await withTotp("replay-a");
    const b = await withTotp("replay-b");

    // The enrolment code is spent: a new sign-in cannot reuse it.
    const enrolmentCode = totpFromUri(a.uri);
    const again = await h.signIn(a.email, PASSWORD);
    expect(again.json?.twoFactorRedirect).toBe(true);
    const replay = await h.call("/two-factor/verify-totp", {
      body: { code: enrolmentCode },
      jar: again.jar,
    });
    expect(replay.status).toBe(401);
    // Refusing the replay did not release the claim.
    const replayAgain = await h.call("/two-factor/verify-totp", {
      body: { code: enrolmentCode },
      jar: again.jar,
    });
    expect(replayAgain.status).toBe(401);

    // A's next code, tried first on B's pending sign-in, is refused there
    // (wrong secret) and stays usable for A.
    const next = totpFromUri(a.uri, Date.now() + 30_000);
    const bSignIn = await h.signIn(b.email, PASSWORD);
    const wrong = await h.call("/two-factor/verify-totp", {
      body: { code: next },
      jar: bSignIn.jar,
    });
    expect(wrong.status).toBe(401);
    const ok = await h.call("/two-factor/verify-totp", {
      body: { code: next },
      jar: again.jar,
    });
    expect(ok.status).toBe(200);
    expect((await sessionActor(again.jar)).mfaSatisfied).toBe(true);

    // And now it is spent, for everyone.
    const third = await h.signIn(a.email, PASSWORD);
    expect(
      (
        await h.call("/two-factor/verify-totp", {
          body: { code: next },
          jar: third.jar,
        })
      ).status,
    ).toBe(401);
  });

  it("lets only one of two concurrent requests with the same code through", async () => {
    await freshStep();
    const a = await withTotp("replay-race");
    const code = totpFromUri(a.uri, Date.now() + 30_000);
    const s1 = await h.signIn(a.email, PASSWORD);
    const s2 = await h.signIn(a.email, PASSWORD);
    const statuses = await Promise.all(
      [s1, s2].map(
        async (s) =>
          (
            await h.call("/two-factor/verify-totp", {
              body: { code },
              jar: s.jar,
            })
          ).status,
      ),
    );
    expect(statuses.sort()).toEqual([200, 401]);
  });

  it("leaves no personal data in any audit detail written by this suite", async () => {
    const result = await h.pool.query<{ d: string }>(
      "select detail::text as d from admin_audit",
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const { d } of result.rows) expect(d).not.toMatch(/@|example\.test/);
  });
});
