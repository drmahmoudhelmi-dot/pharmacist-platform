import { Writable } from "node:stream";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { user } from "@/modules/identity/schema";
import {
  applyToJob,
  exportOwnApplications,
  getApplicationForEmployer,
  getApplyState,
  listJobApplications,
  listMyApplications,
  moveApplication,
  withdrawApplication,
} from "@/modules/jobs/applications";
import { APPLICATION_LIMITS } from "@/modules/jobs/constants";
import { sendApplicationNotice } from "@/modules/jobs/jobs";
import { applicationEvent, jobApplication } from "@/modules/jobs/schema";
import { closeJob, pauseJob } from "@/modules/jobs/service";
import {
  upsertOwnProfessionalDetails,
  upsertOwnProfile,
} from "@/modules/profiles/service";
import type { EmailMessage } from "@/shared/email/sender";
import { createClientBoss, type PgBoss } from "@/shared/jobs/boss";
import { createLogger } from "@/shared/logging/logger";
import { HANDLERS, type WorkerDeps } from "../../worker/handlers";
import { APP_URL, type Harness, startHarness } from "./helpers/auth-harness";
import { fixtures, jobForm, type Person } from "./helpers/fixtures";

// Applications (ADR-007) against real PostgreSQL with pg-boss.

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

const profileForm = {
  displayName: "د. منى الاختبار",
  headline: "صيدلانية مجتمع",
  bio: "خبرة خمس سنوات.",
  careerStage: "pharmacist",
  yearsExperience: "5",
  governorateId: "2",
  specialties: ["community"],
  openToWork: "on",
  visibility: "hidden",
};

async function applicant(label = "applicant", phone = "01012345678") {
  const p = await f.person(label);
  await upsertOwnProfile(h.db, p.actor, profileForm);
  await upsertOwnProfessionalDetails(h.db, p.actor, {
    phone,
    university: "جامعة القاهرة",
    graduationYear: "2019",
  });
  return p;
}

async function apply(
  who: Person,
  jobId: string,
  form: Record<string, unknown> = {
    coverNote: "متاحة فورًا",
    sharePhone: "on",
  },
) {
  return applyToJob(deps, who.actor, jobId, form);
}

async function drainNotices() {
  for (;;) {
    const jobs = await boss.fetch<{ applicationId: string; kind: string }>(
      "applications.notify",
      { batchSize: 20 },
    );
    if (jobs.length === 0) return;
    for (const j of jobs) {
      await HANDLERS["applications.notify"](workerDeps, j.data, j.id);
      await boss.complete("applications.notify", j.id);
    }
  }
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
}, 300_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await h?.stop();
});

describe("applying", () => {
  it("shares a snapshot and the opted-in phone, once per job", async () => {
    const { jobId, owner } = await f.publishedJob();
    const a = await applicant();
    expect(await getApplyState(h.db, a.actor, jobId)).toEqual({
      state: "open",
      canSharePhone: true,
    });
    const result = await apply(a, jobId);
    if (!result.ok) throw new Error(result.error);
    expect(await apply(a, jobId)).toEqual({
      ok: false,
      error: "alreadyApplied",
    });
    expect(await getApplyState(h.db, a.actor, jobId)).toMatchObject({
      state: "applied",
      status: "submitted",
    });

    // The profile changes afterwards; the employer still sees the snapshot.
    await upsertOwnProfile(h.db, a.actor, {
      ...profileForm,
      displayName: "اسم جديد",
    });
    const view = await getApplicationForEmployer(
      h.db,
      owner.actor,
      result.applicationId,
    );
    expect(view).toMatchObject({
      profile: {
        displayName: "د. منى الاختبار",
        careerStage: "pharmacist",
        yearsExperience: 5,
        governorate: { code: "EG-ALX" },
      },
      phoneE164: "+201012345678",
      coverNote: "متاحة فورًا",
      applicantVerified: false,
      moves: ["under_review", "rejected"],
    });
    // Never the applicant's email or user id.
    const text = JSON.stringify(view);
    expect(text).not.toContain(a.email);
    expect(text).not.toContain(a.actor.userId);
    expect(text).not.toContain("جامعة القاهرة");

    const mine = await listMyApplications(h.db, a.actor);
    expect(mine[0]).toMatchObject({
      jobId,
      status: "submitted",
      jobLive: true,
      canWithdraw: true,
    });
  });

  it("shares no phone unless ticked", async () => {
    const { jobId, owner } = await f.publishedJob();
    const a = await applicant("no-phone");
    const result = await apply(a, jobId, { coverNote: "" });
    if (!result.ok) throw new Error(result.error);
    const view = await getApplicationForEmployer(
      h.db,
      owner.actor,
      result.applicationId,
    );
    expect(view?.phoneE164).toBeNull();
    expect(view?.coverNote).toBeNull();
  });

  it("refuses without a profile, to own organization, to non-live jobs and over the limit", async () => {
    const { jobId, owner, organizationId } = await f.publishedJob();
    const bare = await f.person("bare");
    expect(await apply(bare, jobId)).toEqual({ ok: false, error: "noProfile" });
    expect(await getApplyState(h.db, bare.actor, jobId)).toEqual({
      state: "noProfile",
    });
    expect(await getApplyState(h.db, null, jobId)).toEqual({
      state: "signedOut",
    });

    // A recruiter of the job's organization.
    const insider = await applicant("insider");
    await f.addMember(owner, organizationId, insider);
    expect(await apply(insider, jobId)).toEqual({
      ok: false,
      error: "forbidden",
    });

    const a = await applicant("late");
    await pauseJob(deps, owner.actor, jobId);
    expect(await apply(a, jobId)).toEqual({ ok: false, error: "jobClosed" });
    expect(await apply(a, crypto.randomUUID())).toEqual({
      ok: false,
      error: "notFound",
    });
    expect(
      await apply(a, jobId, {
        coverNote: "ن".repeat(APPLICATION_LIMITS.coverNote.max + 1),
      }),
    ).toEqual({
      ok: false,
      error: "validation",
      fieldErrors: { coverNote: "tooLong" },
    });
  });

  it("limits applications per applicant per day", async () => {
    const a = await applicant("busy");
    const limit = APPLICATION_LIMITS.perApplicantPerDay;
    const jobs = await Promise.all(
      Array.from({ length: limit + 1 }, () => f.publishedJob()),
    );
    const results = [];
    for (const j of jobs) results.push(await apply(a, j.jobId));
    expect(results.filter((r) => r.ok)).toHaveLength(limit);
    expect(results.at(-1)).toEqual({ ok: false, error: "limitReached" });
  }, 180_000);

  it("concurrent duplicate applications create exactly one", async () => {
    const { jobId } = await f.publishedJob();
    const a = await applicant("double");
    const results = await Promise.all([apply(a, jobId), apply(a, jobId)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, error: "alreadyApplied" },
    ]);
  });
});

describe("employer side", () => {
  it("moves through the states and emails the applicant on shortlist, accept and reject", async () => {
    const { jobId, owner, organizationId } = await f.publishedJob();
    const recruiter = await f.person("recruiter");
    await f.addMember(owner, organizationId, recruiter);
    const a = await applicant("mover");
    const b = await applicant("other");
    const ra = await apply(a, jobId);
    const rb = await apply(b, jobId);
    if (!ra.ok || !rb.ok) throw new Error("apply");

    const list = await listJobApplications(h.db, recruiter.actor, jobId);
    expect(list.map((x) => x.id)).toEqual([ra.applicationId, rb.applicationId]);
    expect(list[0]).toMatchObject({
      displayName: "د. منى الاختبار",
      status: "submitted",
    });

    // Skipping states is refused; the employer cannot withdraw for the applicant.
    expect(
      await moveApplication(
        deps,
        recruiter.actor,
        ra.applicationId,
        "accepted",
      ),
    ).toEqual({ ok: false, error: "invalidState" });
    expect(
      await moveApplication(
        deps,
        recruiter.actor,
        ra.applicationId,
        "withdrawn",
      ),
    ).toEqual({ ok: false, error: "validation" });

    outbox.length = 0;
    // The worker sends each notice soon after the change (drained per move).
    for (const to of ["under_review", "shortlisted", "accepted"] as const) {
      expect(
        await moveApplication(deps, recruiter.actor, ra.applicationId, to),
      ).toEqual({ ok: true });
      await drainNotices();
    }
    expect(
      await moveApplication(deps, owner.actor, rb.applicationId, "rejected"),
    ).toEqual({ ok: true });
    await drainNotices();
    // Final.
    expect(
      await moveApplication(
        deps,
        owner.actor,
        rb.applicationId,
        "under_review",
      ),
    ).toEqual({ ok: false, error: "invalidState" });
    expect(await withdrawApplication(deps, a.actor, ra.applicationId)).toEqual({
      ok: false,
      error: "invalidState",
    });

    expect(
      outbox.map((m) => [m.to, m.subject.includes("القائمة المختصرة")]),
    ).toEqual([
      [a.email, true],
      [a.email, false],
      [b.email, false],
    ]);
    expect(
      outbox.every((m) => m.text.includes(`${APP_URL}/applications`)),
    ).toBe(true);
    // A notice whose status changed meanwhile is skipped.
    expect(
      await sendApplicationNotice(workerDeps, ra.applicationId, "rejected"),
    ).toBe("skipped");

    const events = await h.db
      .select({
        from: applicationEvent.fromStatus,
        to: applicationEvent.toStatus,
      })
      .from(applicationEvent)
      .where(eq(applicationEvent.applicationId, ra.applicationId))
      .orderBy(applicationEvent.at);
    expect(events.map((e) => `${e.from ?? "-"}>${e.to}`)).toEqual([
      "->submitted",
      "submitted>under_review",
      "under_review>shortlisted",
      "shortlisted>accepted",
    ]);
  });

  it("keeps applications of other organizations out of reach", async () => {
    const { jobId } = await f.publishedJob();
    const other = await f.publishedJob();
    const a = await applicant("idor");
    const r = await apply(a, jobId);
    if (!r.ok) throw new Error("apply");
    for (const who of [other.owner, a, await f.person("nobody")]) {
      expect(await listJobApplications(h.db, who.actor, jobId)).toEqual([]);
      expect(
        await getApplicationForEmployer(h.db, who.actor, r.applicationId),
      ).toBeNull();
      expect(
        await moveApplication(deps, who.actor, r.applicationId, "under_review"),
      ).toEqual({ ok: false, error: "notFound" });
    }
    // Only the applicant withdraws, and only their own.
    expect(
      await withdrawApplication(deps, other.owner.actor, r.applicationId),
    ).toEqual({ ok: false, error: "notFound" });
  });

  it("decides applications of a closed job, but refuses new ones", async () => {
    const { jobId, owner } = await f.publishedJob();
    const a = await applicant("closed-a");
    const r = await apply(a, jobId);
    if (!r.ok) throw new Error("apply");
    await closeJob(deps, owner.actor, jobId);
    expect(
      await moveApplication(deps, owner.actor, r.applicationId, "rejected"),
    ).toEqual({ ok: true });
    expect(await apply(await applicant("closed-b"), jobId)).toEqual({
      ok: false,
      error: "jobClosed",
    });
    expect((await listMyApplications(h.db, a.actor))[0]?.jobLive).toBe(false);
  });
});

describe("applicant rights and integrity", () => {
  it("withdraws, cannot re-apply, and exports what was shared", async () => {
    const { jobId } = await f.publishedJob();
    const a = await applicant("withdraw");
    const r = await apply(a, jobId);
    if (!r.ok) throw new Error("apply");
    expect(await withdrawApplication(deps, a.actor, r.applicationId)).toEqual({
      ok: true,
    });
    expect(await apply(a, jobId)).toEqual({
      ok: false,
      error: "alreadyApplied",
    });
    const exported = await exportOwnApplications(h.db, a.actor);
    expect(exported).toEqual([
      expect.objectContaining({
        jobTitle: jobForm.title,
        status: "withdrawn",
        shared: expect.objectContaining({
          phoneE164: "+201012345678",
          profile: expect.objectContaining({ displayName: "د. منى الاختبار" }),
        }),
      }),
    ]);
  });

  it("the database refuses edits to shared content, illegal transitions and history changes", async () => {
    const { jobId } = await f.publishedJob();
    const a = await applicant("db");
    const r = await apply(a, jobId);
    if (!r.ok) throw new Error("apply");
    await expect(
      h.pool.query(
        "update job_application set cover_note = 'تغيير' where id = $1",
        [r.applicationId],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      h.pool.query(
        "update job_application set status = 'accepted', decided_at = now() where id = $1",
        [r.applicationId],
      ),
    ).rejects.toThrow(/submitted -> accepted not allowed/);
    await expect(
      h.pool.query("delete from application_event where application_id = $1", [
        r.applicationId,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it("deleting the applicant's account removes their applications", async () => {
    const { jobId } = await f.publishedJob();
    const a = await applicant("gone");
    const r = await apply(a, jobId);
    if (!r.ok) throw new Error("apply");
    await h.db.delete(user).where(eq(user.id, a.actor.userId));
    expect(
      await h.db
        .select()
        .from(jobApplication)
        .where(eq(jobApplication.id, r.applicationId)),
    ).toEqual([]);
  });
});
