import "server-only";
import { and, asc, count, desc, eq, gt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Actor } from "@/modules/identity/policy";
import {
  getPublicOrganizations,
  getRoleInOrganization,
} from "@/modules/organizations/service";
import { getOwnApplicationShare } from "@/modules/profiles/service";
import { getVerifiedUserIds } from "@/modules/verification/service";
import { enqueue, type PgBoss } from "@/shared/jobs/boss";
import {
  type ApplicationSnapshot,
  applicationSnapshotSchema,
} from "./application-snapshot";
import {
  APPLICATION_LIMITS,
  type ApplicationNoticeKind,
  type ApplicationStatus,
  type EmployerMove,
  isApplicationStatus,
  isEmployerMove,
} from "./constants";
import { canApplication } from "./policy";
import { applicationEvent, job, jobApplication } from "./schema";
import {
  type ApplicationField,
  type FieldErrors,
  isUuid,
  parseApplication,
  type RawForm,
} from "./validation";

// Applications (ADR-007). The applicant's side (apply, list own, withdraw,
// export) and the employer's side (list a job's applications, read one,
// move it through the states). Every change locks the application row and
// writes an `application_event`. Employer access is decided with the
// caller's role in the job's organization, loaded inside the transaction;
// an application of another organization's job answers `notFound`.

type Db = NodePgDatabase;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type ApplicationsDeps = { db: Db; boss: PgBoss; now?: () => Date };
const nowOf = (deps: { now?: () => Date }) => deps.now?.() ?? new Date();

export type ApplicationError =
  | "forbidden"
  | "validation"
  | "notFound"
  | "invalidState"
  | "limitReached"
  | "noProfile"
  | "alreadyApplied"
  | "jobClosed";

export type ApplicationResult<K extends string = never, T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: ApplicationError; fieldErrors?: FieldErrors<K> };

const fail = (error: ApplicationError) => ({ ok: false as const, error });

const statusOf = (v: string): ApplicationStatus =>
  isApplicationStatus(v) ? v : "submitted";

const NOTICE: Partial<Record<ApplicationStatus, ApplicationNoticeKind>> = {
  shortlisted: "shortlisted",
  accepted: "accepted",
  rejected: "rejected",
};

/** The constraint a unique violation names, through Drizzle's wrapper. */
function uniqueViolation(error: unknown): string | null {
  for (let e: unknown = error, i = 0; e && i < 3; i++) {
    const c = e as { code?: string; constraint?: string; cause?: unknown };
    if (c.code === "23505" && c.constraint) return c.constraint;
    e = c.cause;
  }
  return null;
}

async function event(
  tx: Tx,
  applicationId: string,
  actorId: string | null,
  from: ApplicationStatus | null,
  to: ApplicationStatus,
  at: Date,
) {
  await tx
    .insert(applicationEvent)
    .values({ applicationId, actorId, fromStatus: from, toStatus: to, at });
}

// ---------------------------------------------------------------------------
// Applicant

/**
 * Whether the caller can apply to a job right now, for the job page: a live
 * job, not their own organization's, not applied yet, a saved profile.
 */
export type ApplyState =
  | { state: "signedOut" }
  | { state: "ownOrganization" }
  | { state: "noProfile" }
  | { state: "applied"; applicationId: string; status: ApplicationStatus }
  | { state: "closed" }
  | { state: "open"; canSharePhone: boolean };

export async function getApplyState(
  db: Db,
  actor: Actor | null,
  jobId: unknown,
  now: Date = new Date(),
): Promise<ApplyState> {
  if (!actor || !actor.emailVerified) return { state: "signedOut" };
  if (!isUuid(jobId)) return { state: "closed" };
  const [row] = await db
    .select({
      organizationId: job.organizationId,
      status: job.status,
      expiresAt: job.expiresAt,
    })
    .from(job)
    .where(eq(job.id, jobId))
    .limit(1);
  if (
    !row ||
    row.status !== "published" ||
    !row.expiresAt ||
    row.expiresAt <= now
  )
    return { state: "closed" };
  if (await getRoleInOrganization(db, actor, row.organizationId))
    return { state: "ownOrganization" };
  const [existing] = await db
    .select({ id: jobApplication.id, status: jobApplication.status })
    .from(jobApplication)
    .where(
      and(
        eq(jobApplication.jobId, jobId),
        eq(jobApplication.applicantId, actor.userId),
      ),
    )
    .limit(1);
  if (existing)
    return {
      state: "applied",
      applicationId: existing.id,
      status: statusOf(existing.status),
    };
  const share = await getOwnApplicationShare(db, actor);
  if (!share) return { state: "noProfile" };
  return { state: "open", canSharePhone: share.phoneE164 !== null };
}

/**
 * Applies to a live job with a snapshot of the caller's profile, the phone
 * only if they opted in, and an optional note. One application per job; at
 * most `perApplicantPerDay` a day, serialized per applicant.
 */
export async function applyToJob(
  deps: ApplicationsDeps,
  actor: Actor,
  jobId: unknown,
  raw: RawForm,
): Promise<ApplicationResult<ApplicationField, { applicationId: string }>> {
  if (!actor.emailVerified) return fail("forbidden");
  if (!isUuid(jobId)) return fail("notFound");
  const parsed = parseApplication(raw);
  if (!parsed.ok)
    return { ok: false, error: "validation", fieldErrors: parsed.fieldErrors };
  const now = nowOf(deps);
  const share = await getOwnApplicationShare(deps.db, actor);
  if (!share) return fail("noProfile");
  const snapshot = applicationSnapshotSchema.parse(share.snapshot);

  try {
    return await deps.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`apply:${actor.userId}`}, 0))`,
      );
      // The job must stay live while the application is written.
      const [target] = await tx
        .select({
          organizationId: job.organizationId,
          status: job.status,
          expiresAt: job.expiresAt,
        })
        .from(job)
        .where(eq(job.id, jobId))
        .for("share");
      if (!target) return fail("notFound");
      if (
        target.status !== "published" ||
        !target.expiresAt ||
        target.expiresAt <= now
      )
        return fail("jobClosed");
      const role = await getRoleInOrganization(
        tx,
        actor,
        target.organizationId,
      );
      if (!canApplication(actor, "application.apply", { actorRole: role }))
        return fail("forbidden");
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const [recent] = await tx
        .select({ n: count() })
        .from(jobApplication)
        .where(
          and(
            eq(jobApplication.applicantId, actor.userId),
            gt(jobApplication.submittedAt, dayAgo),
          ),
        );
      if ((recent?.n ?? 0) >= APPLICATION_LIMITS.perApplicantPerDay)
        return fail("limitReached");
      const [row] = await tx
        .insert(jobApplication)
        .values({
          jobId,
          applicantId: actor.userId,
          profileSnapshot: snapshot,
          phoneE164: parsed.data.sharePhone ? share.phoneE164 : null,
          coverNote: parsed.data.coverNote,
          submittedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: jobApplication.id });
      if (!row) throw new Error("application insert returned no row");
      await event(tx, row.id, actor.userId, null, "submitted", now);
      return { ok: true as const, applicationId: row.id };
    });
  } catch (error) {
    if (uniqueViolation(error) === "job_application_job_applicant_key")
      return fail("alreadyApplied");
    throw error;
  }
}

export type MyApplication = {
  id: string;
  jobId: string;
  jobTitle: string;
  organizationName: string;
  status: ApplicationStatus;
  submittedAt: string;
  /** Whether the job is still published (its public page exists). */
  jobLive: boolean;
  canWithdraw: boolean;
};

/** The caller's applications, newest first. */
export async function listMyApplications(
  db: Db,
  actor: Actor,
  now: Date = new Date(),
): Promise<MyApplication[]> {
  if (!actor.emailVerified) return [];
  const rows = await db
    .select({
      id: jobApplication.id,
      jobId: jobApplication.jobId,
      status: jobApplication.status,
      submittedAt: jobApplication.submittedAt,
      jobTitle: job.title,
      jobStatus: job.status,
      expiresAt: job.expiresAt,
      organizationId: job.organizationId,
    })
    .from(jobApplication)
    .innerJoin(job, eq(job.id, jobApplication.jobId))
    .where(eq(jobApplication.applicantId, actor.userId))
    .orderBy(desc(jobApplication.submittedAt), desc(jobApplication.id))
    .limit(200);
  const orgs = await getPublicOrganizations(
    db,
    rows.map((r) => r.organizationId),
  );
  return rows.map((r) => {
    const status = statusOf(r.status);
    return {
      id: r.id,
      jobId: r.jobId,
      jobTitle: r.jobTitle,
      organizationName: orgs.get(r.organizationId)?.name ?? "",
      status,
      submittedAt: r.submittedAt.toISOString(),
      jobLive:
        r.jobStatus === "published" && !!r.expiresAt && r.expiresAt > now,
      canWithdraw: canApplication(actor, "application.withdraw", {
        applicantId: actor.userId,
        status,
      }),
    };
  });
}

export async function withdrawApplication(
  deps: ApplicationsDeps,
  actor: Actor,
  applicationId: unknown,
): Promise<ApplicationResult> {
  if (!isUuid(applicationId)) return fail("notFound");
  const now = nowOf(deps);
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        applicantId: jobApplication.applicantId,
        status: jobApplication.status,
      })
      .from(jobApplication)
      .where(eq(jobApplication.id, applicationId))
      .for("update");
    if (!row || row.applicantId !== actor.userId) return fail("notFound");
    const status = statusOf(row.status);
    if (
      !canApplication(actor, "application.withdraw", {
        applicantId: row.applicantId,
        status,
      })
    )
      return fail("invalidState");
    await tx
      .update(jobApplication)
      .set({ status: "withdrawn", withdrawnAt: now, updatedAt: now })
      .where(eq(jobApplication.id, applicationId));
    await event(tx, applicationId, actor.userId, status, "withdrawn", now);
    return { ok: true as const };
  });
}

export type ApplicationsExportItem = {
  jobTitle: string;
  organizationName: string;
  status: ApplicationStatus;
  submittedAt: string;
  decidedAt: string | null;
  withdrawnAt: string | null;
  shared: {
    profile: ApplicationSnapshot;
    phoneE164: string | null;
    coverNote: string | null;
  };
};

/** The caller's applications and what they shared, for the data export. */
export async function exportOwnApplications(
  db: Db,
  actor: Actor,
): Promise<ApplicationsExportItem[]> {
  if (!actor.emailVerified) return [];
  const rows = await db
    .select({
      jobTitle: job.title,
      organizationId: job.organizationId,
      status: jobApplication.status,
      submittedAt: jobApplication.submittedAt,
      decidedAt: jobApplication.decidedAt,
      withdrawnAt: jobApplication.withdrawnAt,
      profileSnapshot: jobApplication.profileSnapshot,
      phoneE164: jobApplication.phoneE164,
      coverNote: jobApplication.coverNote,
    })
    .from(jobApplication)
    .innerJoin(job, eq(job.id, jobApplication.jobId))
    .where(eq(jobApplication.applicantId, actor.userId))
    .orderBy(asc(jobApplication.submittedAt));
  const orgs = await getPublicOrganizations(
    db,
    rows.map((r) => r.organizationId),
  );
  return rows.map((r) => ({
    jobTitle: r.jobTitle,
    organizationName: orgs.get(r.organizationId)?.name ?? "",
    status: statusOf(r.status),
    submittedAt: r.submittedAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    withdrawnAt: r.withdrawnAt?.toISOString() ?? null,
    shared: {
      profile: r.profileSnapshot,
      phoneE164: r.phoneE164,
      coverNote: r.coverNote,
    },
  }));
}

// ---------------------------------------------------------------------------
// Employer

export type ApplicationSummary = {
  id: string;
  displayName: string;
  careerStage: ApplicationSnapshot["careerStage"];
  yearsExperience: number;
  status: ApplicationStatus;
  submittedAt: string;
  applicantVerified: boolean;
};

/** A job's applications for members of its organization; empty otherwise. */
export async function listJobApplications(
  db: Db,
  actor: Actor,
  jobId: unknown,
): Promise<ApplicationSummary[]> {
  if (!isUuid(jobId)) return [];
  const [target] = await db
    .select({ organizationId: job.organizationId })
    .from(job)
    .where(eq(job.id, jobId))
    .limit(1);
  if (!target) return [];
  const role = await getRoleInOrganization(db, actor, target.organizationId);
  if (!canApplication(actor, "application.read", { actorRole: role }))
    return [];
  const rows = await db
    .select({
      id: jobApplication.id,
      applicantId: jobApplication.applicantId,
      status: jobApplication.status,
      submittedAt: jobApplication.submittedAt,
      profileSnapshot: jobApplication.profileSnapshot,
    })
    .from(jobApplication)
    .where(eq(jobApplication.jobId, jobId))
    .orderBy(asc(jobApplication.submittedAt), asc(jobApplication.id))
    .limit(500);
  const verified = await getVerifiedUserIds(
    db,
    rows.map((r) => r.applicantId),
  );
  return rows.flatMap((r) => {
    const snap = applicationSnapshotSchema.safeParse(r.profileSnapshot);
    if (!snap.success) return [];
    return [
      {
        id: r.id,
        displayName: snap.data.displayName,
        careerStage: snap.data.careerStage,
        yearsExperience: snap.data.yearsExperience,
        status: statusOf(r.status),
        submittedAt: r.submittedAt.toISOString(),
        applicantVerified: verified.has(r.applicantId),
      },
    ];
  });
}

export type EmployerApplicationView = {
  id: string;
  jobId: string;
  jobTitle: string;
  status: ApplicationStatus;
  submittedAt: string;
  profile: ApplicationSnapshot;
  phoneE164: string | null;
  coverNote: string | null;
  applicantVerified: boolean;
  /** Target statuses the caller may move this application to. */
  moves: EmployerMove[];
};

/** One application for a member of the job's organization; null otherwise. */
export async function getApplicationForEmployer(
  db: Db,
  actor: Actor,
  applicationId: unknown,
): Promise<EmployerApplicationView | null> {
  if (!isUuid(applicationId)) return null;
  const [row] = await db
    .select({
      id: jobApplication.id,
      jobId: jobApplication.jobId,
      applicantId: jobApplication.applicantId,
      status: jobApplication.status,
      submittedAt: jobApplication.submittedAt,
      profileSnapshot: jobApplication.profileSnapshot,
      phoneE164: jobApplication.phoneE164,
      coverNote: jobApplication.coverNote,
      jobTitle: job.title,
      organizationId: job.organizationId,
    })
    .from(jobApplication)
    .innerJoin(job, eq(job.id, jobApplication.jobId))
    .where(eq(jobApplication.id, applicationId))
    .limit(1);
  if (!row) return null;
  const role = await getRoleInOrganization(db, actor, row.organizationId);
  if (!canApplication(actor, "application.read", { actorRole: role }))
    return null;
  const snap = applicationSnapshotSchema.safeParse(row.profileSnapshot);
  if (!snap.success) return null;
  const status = statusOf(row.status);
  const verified = await getVerifiedUserIds(db, [row.applicantId]);
  const moves = (
    ["under_review", "shortlisted", "accepted", "rejected"] as const
  ).filter((to) =>
    canApplication(actor, "application.move", { actorRole: role, status, to }),
  );
  return {
    id: row.id,
    jobId: row.jobId,
    jobTitle: row.jobTitle,
    status,
    submittedAt: row.submittedAt.toISOString(),
    profile: snap.data,
    phoneE164: row.phoneE164,
    coverNote: row.coverNote,
    applicantVerified: verified.has(row.applicantId),
    moves,
  };
}

/**
 * Moves an application (employer side). Shortlisted, accepted and rejected
 * email the applicant, in the same transaction.
 */
export async function moveApplication(
  deps: ApplicationsDeps,
  actor: Actor,
  applicationId: unknown,
  to: unknown,
): Promise<ApplicationResult> {
  if (!isUuid(applicationId)) return fail("notFound");
  if (!isEmployerMove(to)) return fail("validation");
  const now = nowOf(deps);
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        status: jobApplication.status,
        organizationId: job.organizationId,
      })
      .from(jobApplication)
      .innerJoin(job, eq(job.id, jobApplication.jobId))
      .where(eq(jobApplication.id, applicationId))
      .for("update", { of: jobApplication });
    if (!row) return fail("notFound");
    const role = await getRoleInOrganization(tx, actor, row.organizationId);
    if (!canApplication(actor, "application.read", { actorRole: role }))
      return fail("notFound");
    const status = statusOf(row.status);
    if (
      !canApplication(actor, "application.move", {
        actorRole: role,
        status,
        to,
      })
    )
      return fail("invalidState");
    const final = to === "accepted" || to === "rejected";
    await tx
      .update(jobApplication)
      .set({ status: to, updatedAt: now, ...(final ? { decidedAt: now } : {}) })
      .where(eq(jobApplication.id, applicationId));
    await event(tx, applicationId, actor.userId, status, to, now);
    const kind = NOTICE[to];
    if (kind)
      await enqueue(
        deps.boss,
        "applications.notify",
        { applicationId, kind },
        { tx },
      );
    return { ok: true as const };
  });
}
