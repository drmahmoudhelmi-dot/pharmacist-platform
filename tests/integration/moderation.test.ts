import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/modules/identity/policy";
import { changeRole } from "@/modules/identity/roles-service";
import {
  findAccountForStaff,
  isSuspended,
  reinstateAccount,
  suspendAccount,
} from "@/modules/identity/suspension";
import {
  applyToJob,
  getApplicationForEmployer,
  moveApplication,
} from "@/modules/jobs/applications";
import { REPORT_LIMITS } from "@/modules/jobs/constants";
import {
  copyJob,
  createJob,
  decideJob,
  dismissReports,
  getJobForMember,
  getJobForModeration,
  getPublicJob,
  getReportState,
  listReportQueue,
  pauseJob,
  removeJob,
  reportJob,
  resumeJob,
  submitJob,
} from "@/modules/jobs/service";
import { leaveOrganization } from "@/modules/organizations/service";
import {
  getProfileForViewer,
  upsertOwnProfile,
} from "@/modules/profiles/service";
import type { EmailMessage } from "@/shared/email/sender";
import { createClientBoss, type PgBoss } from "@/shared/jobs/boss";
import type { JobName } from "@/shared/jobs/registry";
import { createLogger } from "@/shared/logging/logger";
import { HANDLERS, type WorkerDeps } from "../../worker/handlers";
import { APP_URL, type Harness, startHarness } from "./helpers/auth-harness";
import { fixtures, jobForm, PASSWORD, type Person } from "./helpers/fixtures";
import { totpFromUri } from "./helpers/totp";

// Account suspension, job reports and moderator takedown (ADR-009) against
// real PostgreSQL with pg-boss. Staff are real Better Auth accounts whose
// sessions passed TOTP. Synthetic data only.

let h: Harness;
let boss: PgBoss;
let f: ReturnType<typeof fixtures>;
let deps: { db: Harness["db"]; boss: PgBoss };
let workerDeps: WorkerDeps;
const outbox: EmailMessage[] = [];
const logger = createLogger(
  { level: "silent" },
  new Writable({ write: (_c, _e, done) => done() }),
);
let counter = 0;

const profileForm = {
  displayName: "د. سارة الاختبار",
  headline: "صيدلانية",
  bio: "",
  careerStage: "pharmacist",
  yearsExperience: "4",
  governorateId: "1",
  specialties: ["community"],
  openToWork: "on",
  visibility: "members",
};

/** A verified account with a staff role and a session that passed TOTP. */
async function staff(role: "moderator" | "super_admin", label: string) {
  counter += 1;
  const email = `${label}-${counter}@example.test`;
  await h.createVerifiedUser(email, PASSWORD);
  await changeRole(h.db, { email, role, change: "grant" });
  const { jar } = await h.signIn(email, PASSWORD);
  const enable = await h.call("/two-factor/enable", {
    body: { password: PASSWORD },
    jar,
  });
  const uri = enable.json?.totpURI as string;
  await h.call("/two-factor/verify-totp", {
    body: { code: totpFromUri(uri) },
    jar,
  });
  const actor = await f.sessionActor(jar);
  expect(actor.mfaSatisfied).toBe(true);
  return { email, jar, uri, actor };
}

async function drain(queue: JobName) {
  for (;;) {
    const jobs = await boss.fetch<unknown>(queue, { batchSize: 20 });
    if (jobs.length === 0) return;
    for (const j of jobs) {
      await HANDLERS[queue](workerDeps, j.data, j.id);
      await boss.complete(queue, j.id);
    }
  }
}

const mailTo = (to: string) => outbox.filter((m) => m.to === to);

async function auditOf(targetId: string) {
  const result = await h.pool.query(
    "select actor_id, action, detail, ip from admin_audit where target_id = $1 order by at, id",
    [targetId],
  );
  return result.rows;
}

beforeAll(async () => {
  h = await startHarness();
  boss = createClientBoss((text, values) => h.pool.query(text, values), logger);
  await boss.start();
  deps = { db: h.db, boss };
  f = fixtures(h, boss);
  workerDeps = {
    db: h.db,
    boss,
    store: { s3: {} as never, bucket: "unused" },
    scan: async () => ({ infected: false }),
    emailSender: { send: async (m) => void outbox.push(m) },
    appUrl: APP_URL,
    logger,
  };
});

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await h?.stop();
});

// ---------------------------------------------------------------------------

describe("account suspension", () => {
  it("signs the account out, refuses new sessions, hides the profile, audits and emails", async () => {
    const mod = await staff("moderator", "suspender");
    const member = await f.person("suspended");
    const viewer = await f.person("viewer");
    await upsertOwnProfile(h.db, member.actor, profileForm);
    const profileId = (
      await h.pool.query<{ id: string }>(
        "select id from profile where user_id = $1",
        [member.actor.userId],
      )
    ).rows[0]!.id;
    expect(await getProfileForViewer(h.db, viewer.actor, profileId)).not.toBe(
      null,
    );

    expect(
      await suspendAccount(
        deps,
        mod.actor,
        {
          userId: member.actor.userId,
          reasonCode: "fake_jobs",
          note: "ملاحظة داخلية للاختبار",
        },
        "203.0.113.20",
      ),
    ).toEqual({ ok: true });

    expect(await isSuspended(h.db, member.actor.userId)).toBe(true);
    expect((await h.call("/get-session", { jar: member.jar })).json).toBeNull();
    const refused = await h.signIn(member.email, PASSWORD);
    expect(refused.status).toBe(403);
    expect(refused.json?.code).toBe("ACCOUNT_SUSPENDED");
    expect(
      (await h.call("/get-session", { jar: refused.jar })).json,
    ).toBeNull();
    expect(await getProfileForViewer(h.db, viewer.actor, profileId)).toBeNull();

    expect(await auditOf(member.actor.userId)).toEqual([
      {
        actor_id: mod.actor.userId,
        action: "account.suspended",
        detail: { reasonCode: "fake_jobs" },
        ip: "203.0.113.20",
      },
    ]);
    await drain("account.notify");
    const [sent] = mailTo(member.email);
    expect(sent?.subject).toBe("تم إيقاف حسابك - منصة الصيادلة");
    expect(sent?.text).toContain("نشر وظائف وهمية");
    expect(sent?.text).not.toContain("ملاحظة داخلية");

    const lookup = await findAccountForStaff(h.db, mod.actor, member.email);
    expect(lookup).toMatchObject({
      userId: member.actor.userId,
      suspended: true,
      canAct: true,
      isSelf: false,
      history: [
        {
          reasonCode: "fake_jobs",
          note: "ملاحظة داخلية للاختبار",
          suspendedByEmail: mod.email,
          liftedAt: null,
        },
      ],
    });

    expect(
      await reinstateAccount(deps, mod.actor, {
        userId: member.actor.userId,
        reasonCode: "appeal_accepted",
      }),
    ).toEqual({ ok: true });
    expect(await isSuspended(h.db, member.actor.userId)).toBe(false);
    expect((await h.signIn(member.email, PASSWORD)).status).toBe(200);
    expect(await getProfileForViewer(h.db, viewer.actor, profileId)).not.toBe(
      null,
    );
    await drain("account.notify");
    expect(mailTo(member.email).map((m) => m.subject)).toEqual([
      "تم إيقاف حسابك - منصة الصيادلة",
      "تمت إعادة تفعيل حسابك - منصة الصيادلة",
    ]);
    expect((await auditOf(member.actor.userId)).map((r) => r.action)).toEqual([
      "account.suspended",
      "account.reinstated",
    ]);
  });

  it("refuses the session at the TOTP step and at the password step", async () => {
    const mod = await staff("moderator", "totp-suspender");
    const other = await staff("moderator", "totp-target");
    const admin = await staff("super_admin", "totp-admin");
    // A staff account: only a super admin may suspend it.
    expect(
      await suspendAccount(deps, mod.actor, {
        userId: other.actor.userId,
        reasonCode: "other",
      }),
    ).toEqual({ ok: false, error: "staffTarget" });
    // Suspended between the password step and the TOTP step.
    const pending = await h.signIn(other.email, PASSWORD);
    expect(pending.json?.twoFactorRedirect).toBe(true);
    expect(
      await suspendAccount(deps, admin.actor, {
        userId: other.actor.userId,
        reasonCode: "other",
      }),
    ).toEqual({ ok: true });
    const verify = await h.call("/two-factor/verify-totp", {
      body: { code: totpFromUri(other.uri, Date.now() + 30_000) },
      jar: pending.jar,
    });
    expect(verify.status).toBe(403);
    expect(verify.json?.code).toBe("ACCOUNT_SUSPENDED");
    expect(
      (await h.call("/get-session", { jar: pending.jar })).json,
    ).toBeNull();
    // The password step alone is refused too: Better Auth creates a session
    // there before it asks for the code.
    expect((await h.signIn(other.email, PASSWORD)).status).toBe(403);
  });

  it("enforces who may act on whom, once at a time", async () => {
    const mod = await staff("moderator", "rules-mod");
    const member = await f.person("rules-target");
    const target = { userId: member.actor.userId, reasonCode: "spam" };

    expect(await suspendAccount(deps, member.actor, target)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(
      await suspendAccount(deps, { ...mod.actor, mfaSatisfied: false }, target),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(
      await suspendAccount(deps, mod.actor, {
        userId: mod.actor.userId,
        reasonCode: "spam",
      }),
    ).toEqual({ ok: false, error: "self" });
    expect(
      await suspendAccount(deps, mod.actor, { ...target, reasonCode: "nope" }),
    ).toEqual({ ok: false, error: "validation" });
    expect(
      await suspendAccount(deps, mod.actor, {
        ...target,
        note: "x".repeat(501),
      }),
    ).toEqual({ ok: false, error: "validation" });
    expect(
      await suspendAccount(deps, mod.actor, {
        ...target,
        userId: "00000000-0000-4000-8000-000000000000",
      }),
    ).toEqual({ ok: false, error: "notFound" });
    expect(
      await reinstateAccount(deps, mod.actor, {
        userId: member.actor.userId,
        reasonCode: "issued_in_error",
      }),
    ).toEqual({ ok: false, error: "notSuspended" });

    // Two concurrent suspensions: exactly one wins.
    const both = await Promise.all([
      suspendAccount(deps, mod.actor, target),
      suspendAccount(deps, mod.actor, target),
    ]);
    expect(both).toEqual(
      expect.arrayContaining([
        { ok: true },
        { ok: false, error: "alreadySuspended" },
      ]),
    );

    // A moderator whose role was revoked is refused, whatever their session says.
    await changeRole(h.db, {
      email: mod.email,
      role: "moderator",
      change: "revoke",
    });
    expect(
      await reinstateAccount(deps, mod.actor, {
        userId: member.actor.userId,
        reasonCode: "issued_in_error",
      }),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(
      await findAccountForStaff(h.db, member.actor, member.email),
    ).toBeNull();
  });

  it("keeps the history: lifted once, never edited or deleted, gone with the account", async () => {
    const mod = await staff("moderator", "history-mod");
    const member = await f.person("history-target");
    await suspendAccount(deps, mod.actor, {
      userId: member.actor.userId,
      reasonCode: "abuse_or_harassment",
    });
    const id = (
      await h.pool.query<{ id: string }>(
        "select id from account_suspension where user_id = $1",
        [member.actor.userId],
      )
    ).rows[0]!.id;
    await expect(
      h.pool.query(
        "update account_suspension set reason_code = 'spam' where id = $1",
        [id],
      ),
    ).rejects.toThrow();
    await expect(
      h.pool.query("delete from account_suspension where id = $1", [id]),
    ).rejects.toThrow();
    await expect(h.pool.query("truncate account_suspension")).rejects.toThrow();
    await reinstateAccount(deps, mod.actor, {
      userId: member.actor.userId,
      reasonCode: "other",
    });
    await expect(
      h.pool.query(
        "update account_suspension set lifted_at = now(), lift_reason_code = 'appeal_accepted' where id = $1",
        [id],
      ),
    ).rejects.toThrow();
    // A second active suspension is refused by the database as well.
    await h.pool.query(
      "insert into account_suspension (user_id, reason_code) values ($1, 'spam')",
      [member.actor.userId],
    );
    await expect(
      h.pool.query(
        "insert into account_suspension (user_id, reason_code) values ($1, 'spam')",
        [member.actor.userId],
      ),
    ).rejects.toMatchObject({ constraint: "account_suspension_active_unique" });
    await h.pool.query('delete from "user" where id = $1', [
      member.actor.userId,
    ]);
    const left = await h.pool.query(
      "select count(*)::int as n from account_suspension where user_id = $1",
      [member.actor.userId],
    );
    expect(left.rows[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------------------

async function applicant(label: string) {
  const p = await f.person(label);
  await upsertOwnProfile(h.db, p.actor, {
    ...profileForm,
    visibility: "hidden",
  });
  return p;
}

const report = (
  who: Person | { actor: Actor },
  jobId: string,
  reason = "fake_or_scam",
) =>
  reportJob(deps, who.actor, jobId, {
    reasonCode: reason,
    details: "يطلب رسوم تسجيل مقدمًا",
  });

describe("job reports", () => {
  it("takes one open report per member, never from the job's organization", async () => {
    const { jobId, owner } = await f.publishedJob();
    const member = await f.person("reporter");

    expect(await getReportState(h.db, member.actor, jobId)).toBe("available");
    expect(await getReportState(h.db, null, jobId)).toBe("unavailable");
    expect(await report(member, jobId)).toEqual({ ok: true });
    expect(await getReportState(h.db, member.actor, jobId)).toBe("reported");
    expect(await report(member, jobId, "misleading")).toEqual({
      ok: false,
      error: "duplicate",
    });
    expect(await getReportState(h.db, owner.actor, jobId)).toBe("unavailable");
    expect(await report(owner, jobId)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(
      await reportJob(deps, member.actor, jobId, { reasonCode: "nope" }),
    ).toMatchObject({ ok: false, error: "validation" });
    expect(
      await reportJob(deps, member.actor, jobId, {
        reasonCode: "other",
        details: "x".repeat(501),
      }),
    ).toMatchObject({ ok: false, error: "validation" });

    // A paused job is not on the board, so it cannot be reported.
    const another = await f.person("reporter-2");
    await pauseJob(deps, owner.actor, jobId);
    expect(await report(another, jobId)).toEqual({
      ok: false,
      error: "notFound",
    });
    await resumeJob(deps, owner.actor, jobId);

    // The employer never sees who reported, or that anyone did.
    const view = JSON.stringify(
      await getJobForMember(h.db, owner.actor, jobId),
    );
    expect(view).not.toContain(member.email);
    expect(view).not.toContain("رسوم تسجيل");
  });

  it("limits each member to a number of reports per day", async () => {
    const member = await f.person("busy-reporter");
    const jobs = [];
    for (let i = 0; i <= REPORT_LIMITS.perReporterPerDay; i += 1)
      jobs.push((await f.publishedJob()).jobId);
    const results = [];
    for (const jobId of jobs) results.push(await report(member, jobId));
    expect(results.slice(0, -1).every((r) => r.ok)).toBe(true);
    expect(results.at(-1)).toEqual({ ok: false, error: "limitReached" });
  });

  it("queues reported jobs for moderators outside the organization, who may dismiss them", async () => {
    const { jobId, owner, organizationId } = await f.publishedJob();
    const a = await f.person("queue-a");
    const b = await f.person("queue-b");
    await report(a, jobId);
    await report(b, jobId, "discriminatory");

    const mod = await staff("moderator", "queue-mod");
    const queued = (await listReportQueue(h.db, mod.actor)).find(
      (q) => q.jobId === jobId,
    );
    expect(queued).toMatchObject({ openReports: 2, status: "published" });
    expect(queued?.reasons.sort()).toEqual(["discriminatory", "fake_or_scam"]);
    const view = await getJobForModeration(h.db, mod.actor, jobId);
    expect(view?.reports.map((r) => r.reporterEmail).sort()).toEqual(
      [a.email, b.email].sort(),
    );
    expect(view).toMatchObject({ canRemove: true, canDismiss: true });

    // A moderator who belongs to the organization neither sees nor acts.
    const insider = await staff("moderator", "insider-mod");
    await f.addMember(owner, organizationId, {
      ...insider,
      actor: insider.actor,
    });
    expect(
      (await listReportQueue(h.db, insider.actor)).some(
        (q) => q.jobId === jobId,
      ),
    ).toBe(false);
    expect(await getJobForModeration(h.db, insider.actor, jobId)).toBeNull();
    expect(await dismissReports(deps, insider.actor, jobId)).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await listReportQueue(h.db, a.actor)).toEqual([]);

    expect(
      await dismissReports(deps, mod.actor, jobId, "203.0.113.21"),
    ).toEqual({
      ok: true,
    });
    expect(await dismissReports(deps, mod.actor, jobId)).toEqual({
      ok: false,
      error: "invalidState",
    });
    expect(
      (await listReportQueue(h.db, mod.actor)).some((q) => q.jobId === jobId),
    ).toBe(false);
    expect(await auditOf(jobId)).toContainEqual({
      actor_id: mod.actor.userId,
      action: "job.reports_dismissed",
      detail: { count: "2" },
      ip: "203.0.113.21",
    });
    // A dismissed report frees the reporter to report again later.
    expect(await report(a, jobId)).toEqual({ ok: true });
  });

  it("resolves once and is never deleted directly", async () => {
    const { jobId } = await f.publishedJob();
    const member = await f.person("trigger-reporter");
    await report(member, jobId);
    const id = (
      await h.pool.query<{ id: string }>(
        "select id from job_report where job_id = $1",
        [jobId],
      )
    ).rows[0]!.id;
    await expect(
      h.pool.query("update job_report set details = 'x' where id = $1", [id]),
    ).rejects.toThrow();
    await expect(
      h.pool.query("delete from job_report where id = $1", [id]),
    ).rejects.toThrow();
    await h.pool.query(
      "update job_report set status = 'dismissed', resolved_at = now() where id = $1",
      [id],
    );
    await expect(
      h.pool.query(
        "update job_report set status = 'actioned', resolved_at = now() where id = $1",
        [id],
      ),
    ).rejects.toThrow();
    await expect(h.pool.query("truncate job_report")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("takedown", () => {
  it("removes a live job, freezes its applications and tells the creator and applicants", async () => {
    const { jobId, owner } = await f.publishedJob();
    const reporter = await f.person("takedown-reporter");
    await report(reporter, jobId);
    const open = await applicant("open-applicant");
    const decided = await applicant("decided-applicant");
    const a1 = await applyToJob(deps, open.actor, jobId, {});
    const a2 = await applyToJob(deps, decided.actor, jobId, {});
    if (!a1.ok || !a2.ok) throw new Error("apply");
    await moveApplication(deps, owner.actor, a2.applicationId, "rejected");
    await drain("applications.notify");
    outbox.length = 0;

    const mod = await staff("moderator", "takedown-mod");
    expect(
      await removeJob(deps, mod.actor, jobId, { reasonCode: "nope" }),
    ).toMatchObject({ ok: false, error: "validation" });
    expect(
      await removeJob(
        deps,
        mod.actor,
        jobId,
        { reasonCode: "misleading_or_fraud", note: "طلب رسوم من المتقدمين" },
        "203.0.113.22",
      ),
    ).toEqual({ ok: true });

    expect(await getPublicJob(h.db, jobId)).toBeNull();
    const member = await getJobForMember(h.db, owner.actor, jobId);
    expect(member?.status).toBe("removed");
    expect(member?.removal?.reasonCode).toBe("misleading_or_fraud");
    expect(member?.permissions).toEqual({
      edit: false,
      delete: false,
      submit: false,
      pause: false,
      resume: false,
      close: false,
      copy: true,
    });
    expect(JSON.stringify(member)).not.toContain("طلب رسوم");

    // Reports actioned, history and audit written.
    const reports = await h.pool.query(
      "select status from job_report where job_id = $1",
      [jobId],
    );
    expect(reports.rows.map((r) => r.status)).toEqual(["actioned"]);
    const events = await h.pool.query(
      "select from_status, to_status, actor_id from job_event where job_id = $1 order by at desc limit 1",
      [jobId],
    );
    expect(events.rows[0]).toEqual({
      from_status: "published",
      to_status: "removed",
      actor_id: mod.actor.userId,
    });
    expect(await auditOf(jobId)).toContainEqual({
      actor_id: mod.actor.userId,
      action: "job.removed",
      detail: { reasonCode: "misleading_or_fraud" },
      ip: "203.0.113.22",
    });

    // Applications frozen for the employer.
    expect(
      await moveApplication(
        deps,
        owner.actor,
        a1.applicationId,
        "under_review",
      ),
    ).toEqual({ ok: false, error: "invalidState" });
    expect(
      (await getApplicationForEmployer(h.db, owner.actor, a1.applicationId))
        ?.moves,
    ).toEqual([]);

    // Emails: the creator with the reason, the open applicant only.
    await drain("jobs.notify");
    await drain("applications.notify");
    const toOwner = mailTo(owner.email);
    expect(toOwner).toHaveLength(1);
    expect(toOwner[0]?.text).toContain("مضلل");
    expect(toOwner[0]?.text).not.toContain("طلب رسوم");
    expect(mailTo(open.email).map((m) => m.subject)).toEqual([
      "أُزيلت وظيفة «صيدلي مجتمع - وردية صباحية» التي تقدمت لها",
    ]);
    expect(mailTo(decided.email)).toEqual([]);

    // Final: not again, not back to published, even directly.
    expect(
      await removeJob(deps, mod.actor, jobId, { reasonCode: "other" }),
    ).toEqual({ ok: false, error: "invalidState" });
    await expect(
      h.pool.query("update job set status = 'published' where id = $1", [
        jobId,
      ]),
    ).rejects.toThrow();
  });

  it("is refused to members, to the creator and on jobs that are not live", async () => {
    const { jobId, owner, organizationId } = await f.publishedJob();
    const insider = await staff("moderator", "takedown-insider");
    await f.addMember(owner, organizationId, insider);
    expect(
      await removeJob(deps, insider.actor, jobId, { reasonCode: "other" }),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(
      await removeJob(deps, owner.actor, jobId, { reasonCode: "other" }),
    ).toEqual({ ok: false, error: "forbidden" });
    // decideJob cannot be used to remove.
    const mod = await staff("moderator", "takedown-other");
    expect(
      await decideJob(deps, mod.actor, jobId, {
        decision: "removed",
        reasonCode: "other",
      }),
    ).toMatchObject({ ok: false });
    // A draft is not live.
    const copy = await copyJob(deps, owner.actor, jobId);
    if (!copy.ok) throw new Error("copy");
    expect(
      await removeJob(deps, mod.actor, copy.jobId, { reasonCode: "other" }),
    ).toEqual({ ok: false, error: "invalidState" });
  });

  it("puts every later submission of the organization through moderation", async () => {
    const { jobId, owner } = await f.publishedJob();
    // Before a takedown, this verified owner with a published job publishes at once.
    const before = await copyJob(deps, owner.actor, jobId);
    if (!before.ok) throw new Error("copy");
    await submitJob(deps, owner.actor, before.jobId);
    expect(
      (await getJobForMember(h.db, owner.actor, before.jobId))?.status,
    ).toBe("published");

    const mod = await staff("moderator", "repeat-mod");
    await removeJob(deps, mod.actor, jobId, { reasonCode: "discriminatory" });
    const after = await copyJob(deps, owner.actor, jobId);
    if (!after.ok) throw new Error("copy");
    await submitJob(deps, owner.actor, after.jobId);
    expect(
      (await getJobForMember(h.db, owner.actor, after.jobId))?.status,
    ).toBe("pending_review");
  });

  it("is refused to a moderator who created the job, even after leaving its organization", async () => {
    const creator = await staff("moderator", "creator-mod");
    const organizationId = await f.organizationOf(creator);
    const created = await createJob(
      deps,
      creator.actor,
      organizationId,
      jobForm,
    );
    if (!created.ok) throw new Error("create");
    await submitJob(deps, creator.actor, created.jobId);
    const approver = await staff("moderator", "creator-approver");
    expect(
      (
        await decideJob(deps, approver.actor, created.jobId, {
          decision: "approved",
        })
      ).ok,
    ).toBe(true);
    // Hand the organization over and leave it.
    const heir = await f.person("creator-heir");
    await f.addMember(creator, organizationId, heir, "owner");
    expect(
      (await leaveOrganization(deps, creator.actor, organizationId)).ok,
    ).toBe(true);

    const reporter = await f.person("creator-reporter");
    await report(reporter, created.jobId);
    expect(
      (await listReportQueue(h.db, creator.actor)).some(
        (q) => q.jobId === created.jobId,
      ),
    ).toBe(false);
    expect(
      await getJobForModeration(h.db, creator.actor, created.jobId),
    ).toBeNull();
    expect(
      await removeJob(deps, creator.actor, created.jobId, {
        reasonCode: "other",
      }),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(await dismissReports(deps, creator.actor, created.jobId)).toEqual({
      ok: false,
      error: "forbidden",
    });
    // Another moderator may.
    expect(
      (await listReportQueue(h.db, approver.actor)).some(
        (q) => q.jobId === created.jobId,
      ),
    ).toBe(true);
  });

  it("refuses an employer move that waited on a takedown", async () => {
    const { jobId, owner } = await f.publishedJob();
    const who = await applicant("race-applicant");
    const applied = await applyToJob(deps, who.actor, jobId, {});
    if (!applied.ok) throw new Error("apply");
    // A takedown in flight: the job row is updated but not yet committed.
    const client = await h.pool.connect();
    try {
      await client.query("begin");
      await client.query("update job set status = 'removed' where id = $1", [
        jobId,
      ]);
      const move = moveApplication(
        deps,
        owner.actor,
        applied.applicationId,
        "under_review",
      );
      // The move waits for the job's lock instead of reading the old status.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await client.query("commit");
      expect(await move).toEqual({ ok: false, error: "invalidState" });
    } finally {
      client.release();
    }
    const row = await h.pool.query(
      "select status from job_application where id = $1",
      [applied.applicationId],
    );
    expect(row.rows[0].status).toBe("submitted");
  });
});
