import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, actorFromSession } from "@/modules/identity/policy";
import { changeRole, listRoles } from "@/modules/identity/roles-service";
import { LIMITS } from "@/modules/jobs/constants";
import { expireJobs, sendJobNotice } from "@/modules/jobs/jobs";
import { job, jobEvent, jobModerationDecision } from "@/modules/jobs/schema";
import {
  closeJob,
  copyJob,
  createJob,
  decideJob,
  deleteJob,
  getJobForMember,
  getJobForReview,
  getPublicJob,
  type JobsDeps,
  listOrganizationJobs,
  countPendingJobReviews,
  listReviewQueue,
  pauseJob,
  resumeJob,
  searchJobs,
  submitJob,
  updateJob,
} from "@/modules/jobs/service";
import {
  createOrganization,
  inviteMember,
  leaveOrganization,
  respondToInvitation,
} from "@/modules/organizations/service";
import type { EmailMessage } from "@/shared/email/sender";
import { createClientBoss, type PgBoss } from "@/shared/jobs/boss";
import { createLogger } from "@/shared/logging/logger";
import { HANDLERS, type WorkerDeps } from "../../worker/handlers";
import {
  APP_URL,
  type CookieJar,
  type Harness,
  startHarness,
} from "./helpers/auth-harness";
import { totpFromUri } from "./helpers/totp";

// Jobs and moderation (ADR-006) against real PostgreSQL with pg-boss. All
// actors are real Better Auth accounts; the moderator's session passed TOTP.

const PASSWORD = "correct horse battery staple";
let h: Harness;
let boss: PgBoss;
let deps: JobsDeps;
let workerDeps: WorkerDeps;
const outbox: EmailMessage[] = [];
const logger = createLogger(
  { level: "silent" },
  new Writable({ write: (_c, _e, done) => done() }),
);
let counter = 0;

type Person = { email: string; actor: Actor; jar: CookieJar };

async function sessionActor(jar: CookieJar): Promise<Actor> {
  const current = await h.call("/get-session", { jar });
  const session = current.json as unknown as Parameters<
    typeof actorFromSession
  >[0];
  return actorFromSession(session, await listRoles(h.db, session.user.id));
}

async function person(label: string): Promise<Person> {
  counter += 1;
  const email = `${label}-${counter}@example.test`;
  await h.createVerifiedUser(email, PASSWORD);
  const { jar } = await h.signIn(email, PASSWORD);
  return { email, jar, actor: await sessionActor(jar) };
}

async function moderator(label = "moderator"): Promise<Person> {
  counter += 1;
  const email = `${label}-${counter}@example.test`;
  await h.createVerifiedUser(email, PASSWORD);
  await changeRole(h.db, { email, role: "moderator", change: "grant" });
  const { jar } = await h.signIn(email, PASSWORD);
  const enable = await h.call("/two-factor/enable", {
    body: { password: PASSWORD },
    jar,
  });
  await h.call("/two-factor/verify-totp", {
    body: { code: totpFromUri(enable.json?.totpURI as string) },
    jar,
  });
  const actor = await sessionActor(jar);
  expect(actor.mfaSatisfied).toBe(true);
  return { email, jar, actor };
}

/**
 * Test fixture: marks a user as verified with a synthetic submission row
 * (the verification workflow itself is covered by verification.test.ts).
 */
async function markVerified(userId: string) {
  const hex = (n: number) => randomBytes(n).toString("hex");
  await h.pool.query(
    `insert into verification_submission
       (user_id, credential_type, status, legal_name_ar, syndicate_number,
        national_id_ciphertext, national_id_hash, national_id_masked, key_id,
        consent_version, decided_at)
     values ($1, 'pharmacist', 'verified', 'سامي فريد عبد الحميد', '12345',
        $2, $3, '2**********345', $4, 'test', now())`,
    [userId, `v1.${hex(8)}.aaaa.bbbb.cccc`, hex(32), hex(8)],
  );
}

let orgCounter = 0;
async function organizationOf(owner: Person) {
  orgCounter += 1;
  const result = await createOrganization({ db: h.db, boss }, owner.actor, {
    kind: "pharmacy",
    name: `صيدلية الاختبار ${orgCounter}`,
    governorateId: "1",
    addressLine: "",
  });
  if (!result.ok) throw new Error(`organization: ${result.error}`);
  return result.organizationId;
}

/** Adds an existing person to an organization as recruiter. */
async function addRecruiterTo(
  owner: Person,
  organizationId: string,
  who: Person,
) {
  const sent = await inviteMember(
    { db: h.db, boss },
    owner.actor,
    organizationId,
    {
      email: who.email,
      role: "recruiter",
    },
  );
  if (!sent.ok) throw new Error("invite");
  await respondToInvitation(
    { db: h.db, boss },
    who.actor,
    sent.invitationId,
    "accept",
  );
}

async function addRecruiter(owner: Person, organizationId: string) {
  const recruiter = await person("recruiter");
  const sent = await inviteMember(
    { db: h.db, boss },
    owner.actor,
    organizationId,
    {
      email: recruiter.email,
      role: "recruiter",
    },
  );
  if (!sent.ok) throw new Error("invite");
  await respondToInvitation(
    { db: h.db, boss },
    recruiter.actor,
    sent.invitationId,
    "accept",
  );
  return recruiter;
}

const jobForm = {
  title: "صيدلي مجتمع - وردية صباحية",
  category: "pharmacist",
  employmentType: "full_time",
  governorateId: "1",
  area: "مدينة نصر",
  description:
    "نبحث عن صيدلي للعمل في صيدلية مجتمع، مع خبرة في صرف الروشتات وخدمة العملاء.",
  minYearsExperience: "٢",
  careerStages: ["graduate", "pharmacist"],
  salaryMin: "8000",
  salaryMax: "12000",
};

async function draft(by: Person, organizationId: string, form = jobForm) {
  const result = await createJob(deps, by.actor, organizationId, form);
  if (!result.ok) throw new Error(`create: ${result.error}`);
  return result.jobId;
}

async function statusOf(jobId: string) {
  const [row] = await h.db
    .select({ status: job.status })
    .from(job)
    .where(eq(job.id, jobId));
  return row?.status;
}

async function drainNotices() {
  for (;;) {
    const jobs = await boss.fetch<{ jobId: string; kind: string }>(
      "jobs.notify",
      { batchSize: 20 },
    );
    if (jobs.length === 0) return;
    for (const j of jobs) {
      await HANDLERS["jobs.notify"](workerDeps, j.data, j.id);
      await boss.complete("jobs.notify", j.id);
    }
  }
}

beforeAll(async () => {
  h = await startHarness();
  boss = createClientBoss((text, values) => h.pool.query(text, values), logger);
  await boss.start();
  deps = { db: h.db, boss };
  workerDeps = {
    db: h.db,
    boss,
    store: { s3: {} as never, bucket: "unused" },
    scan: async () => ({ infected: false }),
    emailSender: { send: async (m) => void outbox.push(m) },
    appUrl: APP_URL,
    logger,
  };
}, 300_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await h?.stop();
});

describe("drafts", () => {
  it("creates, edits and lists a draft for members only", async () => {
    const owner = await person("owner");
    const org = await organizationOf(owner);
    const recruiter = await addRecruiter(owner, org);
    const stranger = await person("stranger");

    const id = await draft(recruiter, org);
    const view = await getJobForMember(h.db, owner.actor, id);
    expect(view).toMatchObject({
      status: "draft",
      title: "صيدلي مجتمع - وردية صباحية",
      minYearsExperience: 2,
      careerStages: ["graduate", "pharmacist"],
      salaryMinPounds: 8000,
      salaryMaxPounds: 12000,
      governorate: { code: "EG-C" },
      permissions: {
        edit: true,
        delete: true,
        submit: true,
        pause: false,
        close: false,
      },
    });
    const [row] = await h.db.select().from(job).where(eq(job.id, id));
    expect(row?.salaryMin).toBe(800_000);
    expect(row?.searchText).toBe("صيدلي مجتمع ورديه صباحيه مدينه نصر");

    expect(
      await updateJob(deps, owner.actor, id, {
        ...jobForm,
        title: "صيدلي أول",
      }),
    ).toEqual({ ok: true });
    expect(
      (await listOrganizationJobs(h.db, recruiter.actor, org))[0],
    ).toMatchObject({ id, title: "صيدلي أول", status: "draft" });

    // Not visible or writable from outside the organization.
    expect(await getJobForMember(h.db, stranger.actor, id)).toBeNull();
    expect(await listOrganizationJobs(h.db, stranger.actor, org)).toEqual([]);
    expect(await getPublicJob(h.db, id)).toBeNull();
    for (const call of [
      () => updateJob(deps, stranger.actor, id, jobForm),
      () => submitJob(deps, stranger.actor, id),
      () => deleteJob(deps, stranger.actor, id),
      () => copyJob(deps, stranger.actor, id),
      () => createJob(deps, stranger.actor, org, jobForm),
    ])
      expect(await call()).toEqual({ ok: false, error: "notFound" });
  });

  it("validates content, including a temporary period", async () => {
    const owner = await person("validate");
    const org = await organizationOf(owner);
    expect(
      await createJob(deps, owner.actor, org, {
        ...jobForm,
        title: "",
        description: "قصير",
        careerStages: [],
        salaryMin: "9000",
        salaryMax: "5000",
      }),
    ).toEqual({
      ok: false,
      error: "validation",
      fieldErrors: {
        title: "required",
        description: "tooShort",
        careerStages: "required",
        salaryMax: "salaryOrder",
      },
    });
    const now = new Date("2026-10-26T10:00:00Z");
    expect(
      await createJob({ ...deps, now: () => now }, owner.actor, org, {
        ...jobForm,
        category: "pharmacy_manager",
        employmentType: "temporary",
        startDate: "2026-10-01",
        endDate: "2026-09-01",
      }),
    ).toMatchObject({
      ok: false,
      fieldErrors: { startDate: "inPast", endDate: "endBeforeStart" },
    });
    expect(
      await createJob({ ...deps, now: () => now }, owner.actor, org, {
        ...jobForm,
        category: "pharmacy_manager",
        employmentType: "temporary",
        startDate: "٢٠٢٦-١١-٠١",
        endDate: "2026-12-31",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await createJob(deps, owner.actor, org, {
        ...jobForm,
        governorateId: "99",
      }),
    ).toEqual({
      ok: false,
      error: "validation",
      fieldErrors: { governorateId: "invalidChoice" },
    });
  });
});

describe("submission and moderation", () => {
  it("sends the first job to review, publishes on approval and emails the creator", async () => {
    const owner = await person("first");
    await markVerified(owner.actor.userId);
    const org = await organizationOf(owner);
    const mod = await moderator();
    const id = await draft(owner, org);

    expect(await submitJob(deps, owner.actor, id)).toEqual({
      ok: true,
      status: "pending_review",
    });
    expect(await getPublicJob(h.db, id)).toBeNull();
    // Pending jobs cannot be edited.
    expect(await updateJob(deps, owner.actor, id, jobForm)).toEqual({
      ok: false,
      error: "invalidState",
    });

    const queue = await listReviewQueue(h.db, mod.actor);
    expect(queue.map((q) => q.id)).toContain(id);
    expect(await countPendingJobReviews(h.db, mod.actor)).toBe(queue.length);
    expect(await countPendingJobReviews(h.db, owner.actor)).toBeNull();
    expect(queue.find((q) => q.id === id)).toMatchObject({
      posterVerified: true,
      organizationName: expect.stringContaining("صيدلية الاختبار"),
    });
    expect(await getJobForReview(h.db, mod.actor, id)).toMatchObject({
      status: "pending_review",
    });

    expect(
      await decideJob(deps, mod.actor, id, { decision: "approved" }),
    ).toEqual({ ok: true });
    expect(await statusOf(id)).toBe("published");
    const published = await getPublicJob(h.db, id);
    expect(published).toMatchObject({
      id,
      posterVerified: true,
      organization: { kind: "pharmacy" },
    });
    expect(
      Date.parse(published?.expiresAt ?? "") -
        Date.parse(published?.publishedAt ?? ""),
    ).toBe(LIMITS.publishDays * 24 * 60 * 60 * 1000);
    // A second decision finds it no longer pending.
    expect(
      await decideJob(deps, mod.actor, id, {
        decision: "rejected",
        reasonCode: "other",
      }),
    ).toEqual({ ok: false, error: "invalidState" });

    outbox.length = 0;
    await drainNotices();
    expect(outbox.map((m) => m.to)).toEqual([owner.email]);
    expect(outbox[0]?.subject).toContain("صيدلي مجتمع");
    expect(outbox[0]?.text).toContain(`${APP_URL}/manage/jobs/${id}`);

    // The organization's next job from a verified member skips review.
    const second = await draft(owner, org);
    expect(await submitJob(deps, owner.actor, second)).toEqual({
      ok: true,
      status: "published",
    });
  });

  it("reviews every job from an unverified member, rejects with a reason", async () => {
    const owner = await person("unverified-owner");
    await markVerified(owner.actor.userId);
    const org = await organizationOf(owner);
    const recruiter = await addRecruiter(owner, org);
    const mod = await moderator();
    const first = await draft(owner, org);
    await submitJob(deps, owner.actor, first);
    await decideJob(deps, mod.actor, first, { decision: "approved" });

    const id = await draft(recruiter, org);
    expect(await submitJob(deps, recruiter.actor, id)).toEqual({
      ok: true,
      status: "pending_review",
    });
    expect(
      await decideJob(deps, mod.actor, id, { decision: "rejected" }),
    ).toEqual({
      ok: false,
      error: "validation",
      fieldErrors: { reasonCode: "required" },
    });
    expect(
      await decideJob(deps, mod.actor, id, {
        decision: "rejected",
        reasonCode: "contact_details_in_text",
        note: "رقم هاتف في الوصف",
      }),
    ).toEqual({ ok: true });
    const view = await getJobForMember(h.db, recruiter.actor, id);
    expect(view).toMatchObject({
      status: "rejected",
      rejection: { reasonCode: "contact_details_in_text" },
      permissions: { edit: true, submit: true },
    });
    // The internal note never reaches the employer.
    expect(JSON.stringify(view)).not.toContain("رقم هاتف في الوصف");

    outbox.length = 0;
    await drainNotices();
    const mine = outbox.filter((m) => m.to === recruiter.email);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.text).toContain("أرقام هواتف");

    // Fixed and resubmitted: back to review.
    await updateJob(deps, recruiter.actor, id, jobForm);
    expect(await submitJob(deps, recruiter.actor, id)).toMatchObject({
      status: "pending_review",
    });
    const decisions = await h.db
      .select()
      .from(jobModerationDecision)
      .where(eq(jobModerationDecision.jobId, id));
    expect(decisions).toHaveLength(1);
  });

  it("counts pending reviews exactly as the queue lists them", async () => {
    const mod = await moderator("count-mod");
    const queueSize = async () =>
      (await listReviewQueue(h.db, mod.actor)).length;
    const before = await countPendingJobReviews(h.db, mod.actor);
    expect(before).toBe(await queueSize());

    // Someone else's job in someone else's organization: counted.
    const owner = await person("count-owner");
    const org = await organizationOf(owner);
    const id = await draft(owner, org);
    await submitJob(deps, owner.actor, id);
    expect(await countPendingJobReviews(h.db, mod.actor)).toBe(before! + 1);
    expect(await queueSize()).toBe(before! + 1);

    // A job the moderator created and submitted in their own organization
    // is not counted.
    const ownOrg = await organizationOf(mod);
    const own = await draft(mod, ownOrg);
    await submitJob(deps, mod.actor, own);
    expect(await countPendingJobReviews(h.db, mod.actor)).toBe(before! + 1);
    expect(await queueSize()).toBe(before! + 1);

    // Once the moderator joins that organization, its job drops out.
    await addRecruiterTo(owner, org, mod);
    expect(await countPendingJobReviews(h.db, mod.actor)).toBe(before!);
    expect(await queueSize()).toBe(before!);
  });

  it("refuses moderation to non-moderators, members of the organization and without MFA", async () => {
    const owner = await person("mod-owner");
    const org = await organizationOf(owner);
    const id = await draft(owner, org);
    await submitJob(deps, owner.actor, id);

    expect(await listReviewQueue(h.db, owner.actor)).toEqual([]);
    expect(
      await decideJob(deps, owner.actor, id, { decision: "approved" }),
    ).toEqual({ ok: false, error: "forbidden" });

    // A moderator who belongs to the organization.
    const insider = await moderator("insider");
    const sent = await inviteMember({ db: h.db, boss }, owner.actor, org, {
      email: insider.email,
      role: "recruiter",
    });
    if (!sent.ok) throw new Error("invite");
    await respondToInvitation(
      { db: h.db, boss },
      insider.actor,
      sent.invitationId,
      "accept",
    );
    expect(await getJobForReview(h.db, insider.actor, id)).toBeNull();
    expect(
      await decideJob(deps, insider.actor, id, { decision: "approved" }),
    ).toEqual({ ok: false, error: "forbidden" });

    // MFA not satisfied for this session.
    const mod = await moderator();
    const noMfa = { ...mod.actor, mfaSatisfied: false };
    expect(await decideJob(deps, noMfa, id, { decision: "approved" })).toEqual({
      ok: false,
      error: "forbidden",
    });
    expect(await statusOf(id)).toBe("pending_review");
  });

  it("lets exactly one of two concurrent decisions win", async () => {
    const owner = await person("race-owner");
    const org = await organizationOf(owner);
    const id = await draft(owner, org);
    await submitJob(deps, owner.actor, id);
    const a = await moderator();
    const b = await moderator();
    const results = await Promise.all([
      decideJob(deps, a.actor, id, { decision: "approved" }),
      decideJob(deps, b.actor, id, {
        decision: "rejected",
        reasonCode: "incomplete",
      }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(
      await h.db
        .select()
        .from(jobModerationDecision)
        .where(eq(jobModerationDecision.jobId, id)),
    ).toHaveLength(1);
  });
});

describe("review fixes (Opus review of 6a)", () => {
  it("sends a rejected job back to review even when a verified owner resubmits it", async () => {
    const owner = await person("resubmit-owner");
    await markVerified(owner.actor.userId);
    const org = await organizationOf(owner);
    const mod = await moderator();
    const first = await draft(owner, org);
    await submitJob(deps, owner.actor, first);
    await decideJob(deps, mod.actor, first, { decision: "approved" });

    const recruiter = await addRecruiter(owner, org);
    const id = await draft(recruiter, org);
    await submitJob(deps, recruiter.actor, id);
    await decideJob(deps, mod.actor, id, {
      decision: "rejected",
      reasonCode: "misleading_or_fraud",
    });
    // The verified owner would publish directly; a rejected job never does.
    expect(await submitJob(deps, owner.actor, id)).toEqual({
      ok: true,
      status: "pending_review",
    });
    await expect(
      h.pool.query("update job set status = 'rejected' where id = $1", [id]),
    ).resolves.toBeDefined();
    await expect(
      h.pool.query(
        "update job set status = 'published', published_at = now(), first_published_at = now(), expires_at = now() + interval '1 day' where id = $1",
        [id],
      ),
    ).rejects.toThrow(/transition rejected -> published not allowed/);
  });

  it("keeps rejected jobs and their decisions: only never-submitted drafts are deleted", async () => {
    const owner = await person("keep-owner");
    const org = await organizationOf(owner);
    const mod = await moderator();
    const id = await draft(owner, org);
    await submitJob(deps, owner.actor, id);
    await decideJob(deps, mod.actor, id, {
      decision: "rejected",
      reasonCode: "misleading_or_fraud",
    });
    expect(await getJobForMember(h.db, owner.actor, id)).toMatchObject({
      permissions: { delete: false },
    });
    expect(await deleteJob(deps, owner.actor, id)).toEqual({
      ok: false,
      error: "invalidState",
    });
    const fresh = await draft(owner, org);
    expect(await deleteJob(deps, owner.actor, fresh)).toEqual({ ok: true });
    expect(await statusOf(fresh)).toBeUndefined();
  });

  it("never lets a moderator review a job they created, even after leaving the organization", async () => {
    const mod = await moderator("mod-author");
    const org = await organizationOf(mod);
    const id = await draft(mod, org);
    await submitJob(deps, mod.actor, id);
    // Hand the organization to someone else and leave it.
    const other = await person("new-owner");
    const sent = await inviteMember({ db: h.db, boss }, mod.actor, org, {
      email: other.email,
      role: "owner",
    });
    if (!sent.ok) throw new Error("invite");
    await respondToInvitation(
      { db: h.db, boss },
      other.actor,
      sent.invitationId,
      "accept",
    );
    const left = await leaveOrganization({ db: h.db, boss }, mod.actor, org);
    expect(left).toEqual({ ok: true });

    expect(
      (await listReviewQueue(h.db, mod.actor)).map((q) => q.id),
    ).not.toContain(id);
    expect(await getJobForReview(h.db, mod.actor, id)).toBeNull();
    expect(
      await decideJob(deps, mod.actor, id, { decision: "approved" }),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(await statusOf(id)).toBe("pending_review");
  });

  it("copies a temporary job whose period has started; submit names the stale date", async () => {
    const owner = await person("copy-owner");
    const org = await organizationOf(owner);
    const start = new Date("2026-10-26T10:00:00Z");
    const temp = await createJob(
      { ...deps, now: () => start },
      owner.actor,
      org,
      {
        ...jobForm,
        category: "pharmacy_manager",
        employmentType: "temporary",
        startDate: "2026-11-01",
        endDate: "2026-12-31",
      },
    );
    if (!temp.ok) throw new Error("create");
    const later = new Date("2026-11-15T10:00:00Z");
    const copy = await copyJob(
      { ...deps, now: () => later },
      owner.actor,
      temp.jobId,
    );
    if (!copy.ok) throw new Error(`copy: ${copy.error}`);
    expect(await getJobForMember(h.db, owner.actor, copy.jobId)).toMatchObject({
      status: "draft",
      startDate: "2026-11-01",
    });
    expect(
      await submitJob({ ...deps, now: () => later }, owner.actor, copy.jobId),
    ).toEqual({
      ok: false,
      error: "validation",
      fieldErrors: { startDate: "inPast" },
    });
  });

  it("does not email a creator who left the organization; resuming past expiry emails", async () => {
    const owner = await person("notice-owner");
    await markVerified(owner.actor.userId);
    const org = await organizationOf(owner);
    const recruiter = await addRecruiter(owner, org);
    const mod = await moderator();
    const id = await draft(recruiter, org);
    await submitJob(deps, recruiter.actor, id);
    const { leaveOrganization } =
      await import("@/modules/organizations/service");
    await leaveOrganization({ db: h.db, boss }, recruiter.actor, org);
    await decideJob(deps, mod.actor, id, { decision: "approved" });
    outbox.length = 0;
    await drainNotices();
    expect(outbox.filter((m) => m.to === recruiter.email)).toEqual([]);

    // Owner's own job: paused, resumed after expiry → expired + email.
    const own = await draft(owner, org);
    await submitJob(deps, owner.actor, own);
    await pauseJob(deps, owner.actor, own);
    const later = new Date(Date.now() + (LIMITS.publishDays + 1) * 86_400_000);
    await resumeJob({ ...deps, now: () => later }, owner.actor, own);
    outbox.length = 0;
    await drainNotices();
    expect(outbox.map((m) => m.to)).toEqual([owner.email]);
    expect(outbox[0]?.subject).toContain("انتهت");
  });
});

describe("live jobs", () => {
  async function liveJob(form = jobForm) {
    const owner = await person("live-owner");
    await markVerified(owner.actor.userId);
    const org = await organizationOf(owner);
    const mod = await moderator();
    const id = await draft(owner, org, form);
    await submitJob(deps, owner.actor, id);
    await decideJob(deps, mod.actor, id, { decision: "approved" });
    return { owner, org, id };
  }

  it("pauses, resumes and closes; closed is final; only drafts are deleted", async () => {
    const { owner, id } = await liveJob();
    expect(await deleteJob(deps, owner.actor, id)).toEqual({
      ok: false,
      error: "invalidState",
    });
    expect(await pauseJob(deps, owner.actor, id)).toEqual({ ok: true });
    expect(await getPublicJob(h.db, id)).toBeNull();
    expect(await resumeJob(deps, owner.actor, id)).toEqual({
      ok: true,
      status: "published",
    });
    expect(await getPublicJob(h.db, id)).not.toBeNull();
    expect(await closeJob(deps, owner.actor, id)).toEqual({ ok: true });
    for (const call of [
      () => resumeJob(deps, owner.actor, id),
      () => pauseJob(deps, owner.actor, id),
      () => submitJob(deps, owner.actor, id),
      () => updateJob(deps, owner.actor, id, jobForm),
    ])
      expect(await call()).toEqual({ ok: false, error: "invalidState" });
    expect(await getPublicJob(h.db, id)).toBeNull();

    // A copy is a new draft with the same content.
    const copy = await copyJob(deps, owner.actor, id);
    if (!copy.ok) throw new Error("copy");
    expect(await getJobForMember(h.db, owner.actor, copy.jobId)).toMatchObject({
      status: "draft",
      title: jobForm.title,
      salaryMinPounds: 8000,
    });

    const events = await h.db
      .select({ from: jobEvent.fromStatus, to: jobEvent.toStatus })
      .from(jobEvent)
      .where(eq(jobEvent.jobId, id))
      .orderBy(jobEvent.at);
    expect(events.map((e) => `${e.from ?? "-"}>${e.to}`)).toEqual([
      "->draft",
      "draft>pending_review",
      "pending_review>published",
      "published>paused",
      "paused>published",
      "published>closed",
    ]);
  });

  it("the database refuses illegal transitions and history edits", async () => {
    const { id } = await liveJob();
    await expect(
      h.pool.query("update job set status = 'draft' where id = $1", [id]),
    ).rejects.toThrow(/transition published -> draft not allowed/);
    await expect(
      h.pool.query(
        "update job_event set to_status = 'closed' where job_id = $1",
        [id],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      h.pool.query("delete from job_moderation_decision where job_id = $1", [
        id,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it("expires overdue jobs daily, including paused ones, and emails the creator", async () => {
    const { owner, id } = await liveJob();
    const paused = await liveJob();
    await pauseJob(deps, paused.owner.actor, paused.id);
    const later = new Date(Date.now() + (LIMITS.publishDays + 1) * 86_400_000);

    // Still listed until the pass runs, but not to a reader after expiry.
    expect(await getPublicJob(h.db, id, later)).toBeNull();
    const count = await expireJobs({ db: h.db, boss, logger }, later);
    expect(count).toBeGreaterThanOrEqual(2);
    expect(await statusOf(id)).toBe("expired");
    expect(await statusOf(paused.id)).toBe("expired");
    expect(await expireJobs({ db: h.db, boss, logger }, later)).toBe(0);

    outbox.length = 0;
    await drainNotices();
    expect(outbox.map((m) => m.to)).toEqual(
      expect.arrayContaining([owner.email, paused.owner.email]),
    );
    // A stale notice for a job that changed meanwhile is skipped.
    expect(await sendJobNotice(workerDeps, id, "approved")).toBe("sent");
    expect(await sendJobNotice(workerDeps, id, "rejected")).toBe("skipped");
  });

  it("resuming after the expiry date expires the job", async () => {
    const { owner, id } = await liveJob();
    await pauseJob(deps, owner.actor, id);
    const later = new Date(Date.now() + (LIMITS.publishDays + 1) * 86_400_000);
    expect(
      await resumeJob({ ...deps, now: () => later }, owner.actor, id),
    ).toEqual({ ok: true, status: "expired" });
  });
});

describe("public board", () => {
  it("searches with Arabic normalization, filters and keyset pages", async () => {
    const owner = await person("board-owner");
    await markVerified(owner.actor.userId);
    const org = await organizationOf(owner);
    const mod = await moderator();
    const tag = `تجربة${counter}`;
    const ids: string[] = [];
    for (let i = 0; i < LIMITS.pageSize + 2; i++) {
      const id = await draft(owner, org, {
        ...jobForm,
        title: `مدير صيدلية ${tag} رقم ${i + 1}`,
        category: "pharmacy_manager",
        governorateId: i % 2 === 0 ? "1" : "2",
      });
      await submitJob(deps, owner.actor, id);
      if (i === 0)
        await decideJob(deps, mod.actor, id, { decision: "approved" });
      ids.push(id);
    }

    // Taa marbuta typed as haa matches.
    const page1 = await searchJobs(h.db, { q: `مدير صيدليه ${tag}` });
    expect(page1.items).toHaveLength(LIMITS.pageSize);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await searchJobs(h.db, {
      q: `مدير صيدليه ${tag}`,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.items).toHaveLength(2);
    expect(page2.nextCursor).toBeNull();
    const seen = [...page1.items, ...page2.items].map((j) => j.id);
    expect(new Set(seen).size).toBe(LIMITS.pageSize + 2);
    expect(seen.sort()).toEqual([...ids].sort());

    const giza = await searchJobs(h.db, { q: tag, governorate: "2" });
    expect(giza.items.every((j) => j.governorateId === 2)).toBe(true);
    expect(giza.items).toHaveLength((LIMITS.pageSize + 2) / 2);
    expect(
      (await searchJobs(h.db, { q: tag, category: "trainee" })).items,
    ).toEqual([]);
    // Punctuation, including LIKE wildcards, is dropped from the query.
    expect((await searchJobs(h.db, { q: `%_${tag}%` })).items).toHaveLength(
      LIMITS.pageSize,
    );
    // Garbage filters and cursors are ignored, not errors.
    expect(
      (await searchJobs(h.db, { q: tag, governorate: "x", cursor: "!!" }))
        .items,
    ).toHaveLength(LIMITS.pageSize);

    // No personal data on the public view.
    const text = JSON.stringify(page1);
    expect(text).not.toContain(owner.email);
    expect(text).not.toContain(owner.actor.userId);
  });
});
