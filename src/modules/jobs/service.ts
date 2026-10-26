import "server-only";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Actor } from "@/modules/identity/policy";
import {
  getPublicOrganizations,
  getRoleInOrganization,
  type PublicOrganization,
} from "@/modules/organizations/service";
import { listGovernorates } from "@/modules/profiles/governorates";
import {
  getVerificationBadge,
  getVerifiedUserIds,
} from "@/modules/verification/service";
import { enqueue, type PgBoss } from "@/shared/jobs/boss";
import { normalizeForSearch } from "@/shared/text/search";
import {
  type CareerStage,
  CAREER_STAGES,
  type EmploymentType,
  isEmploymentType,
  isJobCategory,
  isJobStatus,
  isRejectReason,
  type JobCategory,
  type JobStatus,
  LIMITS,
  type RejectReason,
} from "./constants";
import { can, type JobAction } from "./policy";
import { job, jobEvent, jobModerationDecision } from "./schema";
import {
  type DecisionField,
  type FieldErrors,
  isUuid,
  type JobField,
  type JobInput,
  parseDecision,
  parseJob,
  parseSearch,
  type RawForm,
} from "./validation";

// All web-side database access for jobs (ADR-006). Every employer action
// locks the job row (`FOR UPDATE`), loads the caller's role in the job's
// organization inside the same transaction (organizations service), checks
// the jobs policy with the current status, and writes a `job_event` row. A
// job of another organization finds no role and answers `notFound`, exactly
// like a missing job. Worker-side code (expiry, emails) is in jobs.ts.

type Db = NodePgDatabase;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type JobsDeps = { db: Db; boss: PgBoss; now?: () => Date };
const nowOf = (deps: { now?: () => Date }) => deps.now?.() ?? new Date();

export type JobError =
  "forbidden" | "validation" | "notFound" | "invalidState" | "limitReached";

export type WriteResult<K extends string = never, T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: JobError; fieldErrors?: FieldErrors<K> };

const fail = (error: JobError) => ({ ok: false as const, error });

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Views

export type GovernorateRef = { code: string; nameAr: string; nameEn: string };

/** The employer-facing content of a job (also the edit form's values). */
export type JobContent = {
  title: string;
  category: JobCategory;
  employmentType: EmploymentType;
  startDate: string | null;
  endDate: string | null;
  governorateId: number;
  governorate: GovernorateRef | null;
  area: string | null;
  description: string;
  minYearsExperience: number;
  careerStages: CareerStage[];
  /** Whole pounds per month. */
  salaryMinPounds: number | null;
  salaryMaxPounds: number | null;
};

export type OrganizationRef = {
  id: string;
  name: string;
  kind: PublicOrganization["kind"];
};

export type PublicJobView = JobContent & {
  id: string;
  organization: OrganizationRef;
  publishedAt: string;
  expiresAt: string;
  /** The submitting member's verification badge; nothing else about them. */
  posterVerified: boolean;
};

export type JobSummary = {
  id: string;
  title: string;
  status: JobStatus;
  category: JobCategory;
  employmentType: EmploymentType;
  updatedAt: string;
  publishedAt: string | null;
  expiresAt: string | null;
};

/** What the actions the caller may take on a job are, for the UI only. */
export type JobPermissions = Record<
  "edit" | "delete" | "submit" | "pause" | "resume" | "close" | "copy",
  boolean
>;

export type MemberJobView = JobContent & {
  id: string;
  status: JobStatus;
  organization: OrganizationRef;
  publishedAt: string | null;
  expiresAt: string | null;
  /** Latest moderation rejection, shown to the employer (no note). */
  rejection: { reasonCode: RejectReason; decidedAt: string } | null;
  permissions: JobPermissions;
};

const contentColumns = {
  title: job.title,
  category: job.category,
  employmentType: job.employmentType,
  startDate: job.startDate,
  endDate: job.endDate,
  governorateId: job.governorateId,
  area: job.area,
  description: job.description,
  minYearsExperience: job.minYearsExperience,
  careerStages: job.careerStages,
  salaryMin: job.salaryMin,
  salaryMax: job.salaryMax,
};

type ContentRow = {
  [K in keyof typeof contentColumns]: (typeof job.$inferSelect)[K];
};

function toContent(
  row: ContentRow,
  governorates: Map<number, GovernorateRef>,
): JobContent {
  return {
    title: row.title,
    category: isJobCategory(row.category) ? row.category : "other",
    employmentType: isEmploymentType(row.employmentType)
      ? row.employmentType
      : "full_time",
    startDate: row.startDate,
    endDate: row.endDate,
    governorateId: row.governorateId,
    governorate: governorates.get(row.governorateId) ?? null,
    area: row.area,
    description: row.description,
    minYearsExperience: row.minYearsExperience,
    careerStages: CAREER_STAGES.filter((s) => row.careerStages.includes(s)),
    salaryMinPounds: row.salaryMin === null ? null : row.salaryMin / 100,
    salaryMaxPounds: row.salaryMax === null ? null : row.salaryMax / 100,
  };
}

async function governorateMap(db: Db) {
  return new Map(
    (await listGovernorates(db)).map((g) => [
      g.id,
      { code: g.code, nameAr: g.nameAr, nameEn: g.nameEn },
    ]),
  );
}

const statusOf = (value: string): JobStatus =>
  isJobStatus(value) ? value : "draft";

const searchTextOf = (input: Pick<JobInput, "title" | "area">) =>
  normalizeForSearch([input.title, input.area ?? ""].join(" "));

function rowValues(input: JobInput) {
  return {
    title: input.title,
    category: input.category,
    employmentType: input.employmentType,
    startDate: input.startDate,
    endDate: input.endDate,
    governorateId: input.governorateId,
    area: input.area,
    description: input.description,
    minYearsExperience: input.minYearsExperience,
    careerStages: input.careerStages,
    salaryMin: input.salaryMin,
    salaryMax: input.salaryMax,
    searchText: searchTextOf(input),
  };
}

async function event(
  tx: Tx,
  jobId: string,
  actorId: string | null,
  from: JobStatus | null,
  to: JobStatus,
  at: Date,
) {
  await tx
    .insert(jobEvent)
    .values({ jobId, actorId, fromStatus: from, toStatus: to, at });
}

async function governorateExists(db: Db, id: number) {
  return (await listGovernorates(db)).some((g) => g.id === id);
}

// ---------------------------------------------------------------------------
// Employer: creating and editing

/** Creates a draft for an organization the caller manages jobs for. */
export async function createJob(
  deps: JobsDeps,
  actor: Actor,
  organizationId: unknown,
  raw: RawForm,
): Promise<WriteResult<JobField, { jobId: string }>> {
  if (!isUuid(organizationId)) return fail("notFound");
  const now = nowOf(deps);
  const parsed = parseJob(raw, now);
  return deps.db.transaction(async (tx) => {
    const role = await getRoleInOrganization(tx, actor, organizationId);
    if (!role) return fail("notFound");
    if (!can(actor, "job.create", { actorRole: role }))
      return fail("forbidden");
    if (!parsed.ok)
      return {
        ok: false as const,
        error: "validation" as const,
        fieldErrors: parsed.fieldErrors,
      };
    if (!(await governorateExists(deps.db, parsed.data.governorateId)))
      return {
        ok: false as const,
        error: "validation" as const,
        fieldErrors: { governorateId: "invalidChoice" as const },
      };
    return insertDraft(tx, actor, organizationId, rowValues(parsed.data), now);
  });
}

/**
 * Inserts a draft under the open-jobs limit, serialized per organization so
 * the limit holds under concurrent requests. The caller has checked the role.
 */
async function insertDraft(
  tx: Tx,
  actor: Actor,
  organizationId: string,
  values: ReturnType<typeof rowValues>,
  now: Date,
): Promise<{ ok: true; jobId: string } | { ok: false; error: JobError }> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`jobs:${organizationId}`}, 0))`,
  );
  const [open] = await tx
    .select({ n: count() })
    .from(job)
    .where(
      and(
        eq(job.organizationId, organizationId),
        inArray(job.status, [
          "draft",
          "rejected",
          "pending_review",
          "published",
          "paused",
        ]),
      ),
    );
  if ((open?.n ?? 0) >= LIMITS.openJobsPerOrganization)
    return fail("limitReached");
  const [row] = await tx
    .insert(job)
    .values({
      ...values,
      organizationId,
      status: "draft",
      createdBy: actor.userId,
      updatedBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: job.id });
  if (!row) throw new Error("job insert returned no row");
  await event(tx, row.id, actor.userId, null, "draft", now);
  return { ok: true, jobId: row.id };
}

/** Locks a job and resolves the caller's role in its organization. */
async function lockForMember(tx: Tx, actor: Actor, jobId: string) {
  const [row] = await tx
    .select({
      id: job.id,
      organizationId: job.organizationId,
      status: job.status,
      expiresAt: job.expiresAt,
      firstPublishedAt: job.firstPublishedAt,
      submittedAt: job.submittedAt,
    })
    .from(job)
    .where(eq(job.id, jobId))
    .for("update");
  if (!row) return null;
  const role = await getRoleInOrganization(tx, actor, row.organizationId);
  if (!role) return null;
  return { ...row, status: statusOf(row.status), role };
}

/**
 * Runs one employer action: lock, role, policy, then `work`. Missing jobs and
 * other organizations' jobs are `notFound`; a member whose role or the job's
 * status does not allow the action gets `invalidState` (status) or
 * `forbidden` (role).
 */
async function asMember<K extends string, T>(
  deps: JobsDeps,
  actor: Actor,
  jobId: unknown,
  action: JobAction,
  work: (
    tx: Tx,
    current: NonNullable<Awaited<ReturnType<typeof lockForMember>>>,
    now: Date,
  ) => Promise<WriteResult<K, T>>,
): Promise<WriteResult<K, T>> {
  if (!isUuid(jobId)) return fail("notFound");
  const now = nowOf(deps);
  return deps.db.transaction(async (tx) => {
    const current = await lockForMember(tx, actor, jobId);
    if (!current) return fail("notFound");
    if (
      !can(actor, "job.read", {
        actorRole: current.role,
        status: current.status,
      })
    )
      return fail("forbidden");
    if (
      !can(actor, action, { actorRole: current.role, status: current.status })
    )
      return fail("invalidState");
    return work(tx, current, now);
  });
}

export async function updateJob(
  deps: JobsDeps,
  actor: Actor,
  jobId: unknown,
  raw: RawForm,
): Promise<WriteResult<JobField>> {
  const parsed = parseJob(raw, nowOf(deps));
  return asMember<JobField, object>(
    deps,
    actor,
    jobId,
    "job.edit",
    async (tx, current, now) => {
      if (!parsed.ok)
        return {
          ok: false,
          error: "validation",
          fieldErrors: parsed.fieldErrors,
        };
      if (!(await governorateExists(deps.db, parsed.data.governorateId)))
        return {
          ok: false,
          error: "validation",
          fieldErrors: { governorateId: "invalidChoice" },
        };
      await tx
        .update(job)
        .set({
          ...rowValues(parsed.data),
          updatedBy: actor.userId,
          updatedAt: now,
        })
        .where(eq(job.id, current.id));
      return { ok: true };
    },
  );
}

/**
 * Deletes a draft that was never submitted. Anything a moderator has seen
 * stays, with its decisions and history (ADR-006).
 */
export async function deleteJob(
  deps: JobsDeps,
  actor: Actor,
  jobId: unknown,
): Promise<WriteResult> {
  return asMember<never, object>(
    deps,
    actor,
    jobId,
    "job.delete",
    async (tx, current) => {
      if (current.submittedAt) return fail("invalidState");
      await tx.delete(job).where(eq(job.id, current.id));
      return { ok: true };
    },
  );
}

/**
 * A new draft with the same content, for corrections to a live or closed job.
 * The content is copied as stored, even a temporary period that has started
 * meanwhile: the draft cannot be submitted until the employer sets new dates
 * (submitJob checks the period again).
 */
export async function copyJob(
  deps: JobsDeps,
  actor: Actor,
  jobId: unknown,
): Promise<WriteResult<never, { jobId: string }>> {
  if (!isUuid(jobId)) return fail("notFound");
  const now = nowOf(deps);
  return deps.db.transaction(async (tx) => {
    const [source] = await tx
      .select({
        organizationId: job.organizationId,
        status: job.status,
        ...contentColumns,
      })
      .from(job)
      .where(eq(job.id, jobId))
      .limit(1);
    if (!source) return fail("notFound");
    const role = await getRoleInOrganization(tx, actor, source.organizationId);
    if (!role) return fail("notFound");
    if (
      !can(actor, "job.copy", {
        actorRole: role,
        status: statusOf(source.status),
      })
    )
      return fail("forbidden");
    const { organizationId, ...rest } = source;
    const content = Object.fromEntries(
      Object.keys(contentColumns).map((k) => [k, rest[k as keyof ContentRow]]),
    ) as ContentRow;
    return insertDraft(
      tx,
      actor,
      organizationId,
      { ...content, searchText: searchTextOf(content) },
      now,
    );
  });
}

// ---------------------------------------------------------------------------
// Employer: transitions

/**
 * Moderation is needed for an organization's first public job and whenever
 * the submitting member is not verified (ADR-006).
 */
async function needsModeration(tx: Tx, actor: Actor, organizationId: string) {
  const [published] = await tx
    .select({ n: count() })
    .from(job)
    .where(
      and(
        eq(job.organizationId, organizationId),
        sql`${job.firstPublishedAt} is not null`,
      ),
    );
  if ((published?.n ?? 0) === 0) return true;
  return (
    (await getVerificationBadge(tx as unknown as Db, actor.userId)) !==
    "verified"
  );
}

function publishValues(now: Date, firstPublishedAt: Date | null) {
  return {
    status: "published" as const,
    publishedAt: now,
    firstPublishedAt: firstPublishedAt ?? now,
    expiresAt: new Date(now.getTime() + LIMITS.publishDays * DAY),
  };
}

export async function submitJob(
  deps: JobsDeps,
  actor: Actor,
  jobId: unknown,
): Promise<
  WriteResult<
    "startDate" | "endDate",
    { status: "pending_review" | "published" }
  >
> {
  return asMember<
    "startDate" | "endDate",
    { status: "pending_review" | "published" }
  >(deps, actor, jobId, "job.submit", async (tx, current, now) => {
    // Content checks again at submit time: a temporary period may have
    // started meanwhile.
    const [row] = await tx
      .select(contentColumns)
      .from(job)
      .where(eq(job.id, current.id));
    if (row?.employmentType === "temporary") {
      const checked = parseJob(
        {
          ...row,
          startDate: row.startDate ?? "",
          endDate: row.endDate ?? "",
          governorateId: String(row.governorateId),
          minYearsExperience: String(row.minYearsExperience),
          salaryMin: "",
          salaryMax: "",
        },
        now,
      );
      if (!checked.ok) {
        const { startDate, endDate } = checked.fieldErrors;
        return {
          ok: false,
          error: "validation",
          fieldErrors: {
            ...(startDate ? { startDate } : {}),
            ...(endDate ? { endDate } : {}),
          },
        };
      }
    }
    // A job a moderator rejected always goes back to review (ADR-006).
    const review =
      current.status === "rejected" ||
      (await needsModeration(tx, actor, current.organizationId));
    const to = review ? "pending_review" : "published";
    await tx
      .update(job)
      .set({
        ...(review
          ? { status: "pending_review" as const }
          : publishValues(now, current.firstPublishedAt)),
        submittedAt: now,
        submittedBy: actor.userId,
        updatedAt: now,
      })
      .where(eq(job.id, current.id));
    await event(tx, current.id, actor.userId, current.status, to, now);
    return { ok: true, status: to };
  });
}

export async function pauseJob(
  deps: JobsDeps,
  actor: Actor,
  jobId: unknown,
): Promise<WriteResult> {
  return asMember<never, object>(
    deps,
    actor,
    jobId,
    "job.pause",
    async (tx, current, now) => {
      await tx
        .update(job)
        .set({ status: "paused", updatedAt: now })
        .where(eq(job.id, current.id));
      await event(tx, current.id, actor.userId, "published", "paused", now);
      return { ok: true };
    },
  );
}

/** Back to published, unless it expired while paused (then `expired`). */
export async function resumeJob(
  deps: JobsDeps,
  actor: Actor,
  jobId: unknown,
): Promise<WriteResult<never, { status: "published" | "expired" }>> {
  return asMember<never, { status: "published" | "expired" }>(
    deps,
    actor,
    jobId,
    "job.resume",
    async (tx, current, now) => {
      const expired = current.expiresAt !== null && current.expiresAt <= now;
      const to = expired ? "expired" : "published";
      await tx
        .update(job)
        .set({ status: to, updatedAt: now })
        .where(eq(job.id, current.id));
      await event(tx, current.id, actor.userId, "paused", to, now);
      // Same notice as the daily expiry pass.
      if (expired)
        await enqueue(
          deps.boss,
          "jobs.notify",
          { jobId: current.id, kind: "expired" },
          { tx },
        );
      return { ok: true, status: to };
    },
  );
}

export async function closeJob(
  deps: JobsDeps,
  actor: Actor,
  jobId: unknown,
): Promise<WriteResult> {
  return asMember<never, object>(
    deps,
    actor,
    jobId,
    "job.close",
    async (tx, current, now) => {
      await tx
        .update(job)
        .set({ status: "closed", closedAt: now, updatedAt: now })
        .where(eq(job.id, current.id));
      await event(tx, current.id, actor.userId, current.status, "closed", now);
      return { ok: true };
    },
  );
}

// ---------------------------------------------------------------------------
// Employer: reading

/** Every job of an organization, newest first, for its members. */
export async function listOrganizationJobs(
  db: Db,
  actor: Actor,
  organizationId: unknown,
): Promise<JobSummary[]> {
  const role = await getRoleInOrganization(db, actor, organizationId);
  if (!role || !can(actor, "job.create", { actorRole: role })) return [];
  const rows = await db
    .select({
      id: job.id,
      title: job.title,
      status: job.status,
      category: job.category,
      employmentType: job.employmentType,
      updatedAt: job.updatedAt,
      publishedAt: job.publishedAt,
      expiresAt: job.expiresAt,
    })
    .from(job)
    .where(eq(job.organizationId, organizationId as string))
    .orderBy(desc(job.createdAt), desc(job.id));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: statusOf(r.status),
    category: isJobCategory(r.category) ? r.category : "other",
    employmentType: isEmploymentType(r.employmentType)
      ? r.employmentType
      : "full_time",
    updatedAt: r.updatedAt.toISOString(),
    publishedAt: r.publishedAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
  }));
}

/** One job with its status and allowed actions, for its organization's members. */
export async function getJobForMember(
  db: Db,
  actor: Actor,
  jobId: unknown,
): Promise<MemberJobView | null> {
  if (!isUuid(jobId)) return null;
  const [row] = await db
    .select({
      id: job.id,
      organizationId: job.organizationId,
      status: job.status,
      publishedAt: job.publishedAt,
      expiresAt: job.expiresAt,
      submittedAt: job.submittedAt,
      ...contentColumns,
    })
    .from(job)
    .where(eq(job.id, jobId))
    .limit(1);
  if (!row) return null;
  const role = await getRoleInOrganization(db, actor, row.organizationId);
  const status = statusOf(row.status);
  if (!role || !can(actor, "job.read", { actorRole: role, status }))
    return null;
  const [orgs, governorates, [rejection]] = await Promise.all([
    getPublicOrganizations(db, [row.organizationId]),
    governorateMap(db),
    db
      .select({
        decision: jobModerationDecision.decision,
        reasonCode: jobModerationDecision.reasonCode,
        decidedAt: jobModerationDecision.decidedAt,
      })
      .from(jobModerationDecision)
      .where(eq(jobModerationDecision.jobId, row.id))
      .orderBy(desc(jobModerationDecision.decidedAt))
      .limit(1),
  ]);
  const org = orgs.get(row.organizationId);
  if (!org) return null;
  const r = { actorRole: role, status };
  return {
    id: row.id,
    status,
    organization: { id: org.id, name: org.name, kind: org.kind },
    publishedAt: row.publishedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    ...toContent(row, governorates),
    rejection:
      status === "rejected" &&
      rejection?.decision === "rejected" &&
      isRejectReason(rejection.reasonCode)
        ? {
            reasonCode: rejection.reasonCode,
            decidedAt: rejection.decidedAt.toISOString(),
          }
        : null,
    permissions: {
      edit: can(actor, "job.edit", r),
      delete: can(actor, "job.delete", r) && row.submittedAt === null,
      submit: can(actor, "job.submit", r),
      pause: can(actor, "job.pause", r),
      resume: can(actor, "job.resume", r),
      close: can(actor, "job.close", r),
      copy: can(actor, "job.copy", r),
    },
  };
}

// ---------------------------------------------------------------------------
// Public board

const isLive = (now: Date) =>
  and(eq(job.status, "published"), gt(job.expiresAt, now));

function encodeCursor(publishedAt: Date, id: string) {
  return Buffer.from(`${publishedAt.toISOString()}|${id}`).toString(
    "base64url",
  );
}

function decodeCursor(cursor: string | null) {
  if (!cursor) return null;
  const [iso, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime()) || !isUuid(id)) return null;
  return { at, id };
}

/** `%`, `_` and `\` in user input match themselves in LIKE. */
const likeEscape = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

async function toPublicViews(
  db: Db,
  rows: (ContentRow & {
    id: string;
    organizationId: string;
    publishedAt: Date | null;
    expiresAt: Date | null;
    submittedBy: string | null;
  })[],
): Promise<PublicJobView[]> {
  const [orgs, governorates] = await Promise.all([
    getPublicOrganizations(
      db,
      rows.map((r) => r.organizationId),
    ),
    governorateMap(db),
  ]);
  const verified = await getVerifiedUserIds(
    db,
    rows.map((r) => r.submittedBy).filter(isUuid),
  );
  return rows.flatMap((r) => {
    const org = orgs.get(r.organizationId);
    if (!org || !r.publishedAt || !r.expiresAt) return [];
    return [
      {
        id: r.id,
        organization: { id: org.id, name: org.name, kind: org.kind },
        publishedAt: r.publishedAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        posterVerified: r.submittedBy !== null && verified.has(r.submittedBy),
        ...toContent(r, governorates),
      },
    ];
  });
}

const publicColumns = {
  id: job.id,
  organizationId: job.organizationId,
  publishedAt: job.publishedAt,
  expiresAt: job.expiresAt,
  submittedBy: job.submittedBy,
  ...contentColumns,
};

export type BoardPage = { items: PublicJobView[]; nextCursor: string | null };

/**
 * The public job board: live jobs, newest first, keyset pages of
 * `LIMITS.pageSize`. Filters come from the URL and are parsed leniently.
 */
export async function searchJobs(
  db: Db,
  rawQuery: Record<string, string | undefined>,
  now: Date = new Date(),
): Promise<BoardPage> {
  const query = parseSearch(rawQuery);
  const cursor = decodeCursor(query.cursor);
  const needle = normalizeForSearch(query.q);
  const conditions = [
    isLive(now),
    query.governorateId !== null
      ? eq(job.governorateId, query.governorateId)
      : undefined,
    query.category ? eq(job.category, query.category) : undefined,
    query.employmentType
      ? eq(job.employmentType, query.employmentType)
      : undefined,
    needle !== ""
      ? sql`${job.searchText} ilike ${`%${likeEscape(needle)}%`}`
      : undefined,
    cursor
      ? or(
          lt(job.publishedAt, cursor.at),
          and(eq(job.publishedAt, cursor.at), lt(job.id, cursor.id)),
        )
      : undefined,
  ];
  const rows = await db
    .select(publicColumns)
    .from(job)
    .where(and(...conditions))
    .orderBy(desc(job.publishedAt), desc(job.id))
    .limit(LIMITS.pageSize + 1);
  const page = rows.slice(0, LIMITS.pageSize);
  const last = page.at(-1);
  return {
    items: await toPublicViews(db, page),
    nextCursor:
      rows.length > LIMITS.pageSize && last?.publishedAt
        ? encodeCursor(last.publishedAt, last.id)
        : null,
  };
}

/**
 * A live job for anyone (signed in or not). Anything else is null, so the
 * page answers 404; members see their own jobs through `getJobForMember`.
 */
export async function getPublicJob(
  db: Db,
  jobId: unknown,
  now: Date = new Date(),
): Promise<PublicJobView | null> {
  if (!isUuid(jobId)) return null;
  const rows = await db
    .select(publicColumns)
    .from(job)
    .where(and(eq(job.id, jobId), isLive(now)))
    .limit(1);
  return (await toPublicViews(db, rows))[0] ?? null;
}

// ---------------------------------------------------------------------------
// Moderation

/**
 * Nobody reviews a job they created or submitted, even after leaving its
 * organization (current membership is checked separately).
 */
const isOwnJob = (
  moderator: Actor,
  row: { createdBy: string | null; submittedBy: string | null },
) => row.createdBy === moderator.userId || row.submittedBy === moderator.userId;

export type ReviewQueueItem = {
  id: string;
  title: string;
  organizationName: string;
  submittedAt: string;
  posterVerified: boolean;
};

/** Pending jobs, oldest first, for moderators. */
export async function listReviewQueue(
  db: Db,
  moderator: Actor,
): Promise<ReviewQueueItem[]> {
  if (!can(moderator, "job.reviewQueue")) return [];
  const all = await db
    .select({
      id: job.id,
      title: job.title,
      organizationId: job.organizationId,
      submittedAt: job.submittedAt,
      submittedBy: job.submittedBy,
      createdBy: job.createdBy,
    })
    .from(job)
    .where(eq(job.status, "pending_review"))
    .orderBy(asc(job.submittedAt), asc(job.id))
    .limit(100);
  // Jobs this moderator may not review are left out of their queue.
  const reviewable = (
    await Promise.all(
      all.map(async (r) =>
        isOwnJob(moderator, r) ||
        (await getRoleInOrganization(db, moderator, r.organizationId))
          ? null
          : r,
      ),
    )
  ).filter((r) => r !== null);
  const [orgs, verified] = await Promise.all([
    getPublicOrganizations(
      db,
      reviewable.map((r) => r.organizationId),
    ),
    getVerifiedUserIds(db, reviewable.map((r) => r.submittedBy).filter(isUuid)),
  ]);
  return reviewable.map((r) => ({
    id: r.id,
    title: r.title,
    organizationName: orgs.get(r.organizationId)?.name ?? "",
    submittedAt: (r.submittedAt ?? new Date(0)).toISOString(),
    posterVerified: r.submittedBy !== null && verified.has(r.submittedBy),
  }));
}

export type ReviewView = PublicJobView & { status: JobStatus };

/** One pending job for a moderator who does not belong to its organization. */
export async function getJobForReview(
  db: Db,
  moderator: Actor,
  jobId: unknown,
): Promise<ReviewView | null> {
  if (!can(moderator, "job.reviewQueue") || !isUuid(jobId)) return null;
  const [row] = await db
    .select({ ...publicColumns, status: job.status, createdBy: job.createdBy })
    .from(job)
    .where(eq(job.id, jobId))
    .limit(1);
  if (!row) return null;
  const role = await getRoleInOrganization(db, moderator, row.organizationId);
  const status = statusOf(row.status);
  if (!can(moderator, "job.review", { actorRole: role, status })) return null;
  if (isOwnJob(moderator, row)) return null;
  // Not yet published: show it with placeholder dates.
  const [view] = await toPublicViews(db, [
    {
      ...row,
      publishedAt: row.publishedAt ?? new Date(0),
      expiresAt: row.expiresAt ?? new Date(0),
    },
  ]);
  return view ? { ...view, status } : null;
}

export type DecideResult = WriteResult<DecisionField>;

/**
 * Approve (publish now) or reject with a reason. Exactly one decision per
 * submission: the job row is locked and must still be pending. The creator
 * is emailed (job `jobs.notify`) in the same transaction.
 */
export async function decideJob(
  deps: JobsDeps,
  moderator: Actor,
  jobId: unknown,
  raw: RawForm,
): Promise<DecideResult> {
  if (!can(moderator, "job.reviewQueue")) return fail("forbidden");
  if (!isUuid(jobId)) return fail("notFound");
  const parsed = parseDecision(raw);
  if (!parsed.ok)
    return { ok: false, error: "validation", fieldErrors: parsed.fieldErrors };
  const now = nowOf(deps);
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: job.id,
        organizationId: job.organizationId,
        status: job.status,
        firstPublishedAt: job.firstPublishedAt,
        createdBy: job.createdBy,
        submittedBy: job.submittedBy,
      })
      .from(job)
      .where(eq(job.id, jobId))
      .for("update");
    if (!row) return fail("notFound");
    const role = await getRoleInOrganization(tx, moderator, row.organizationId);
    if (role || isOwnJob(moderator, row)) return fail("forbidden");
    const status = statusOf(row.status);
    if (!can(moderator, "job.review", { actorRole: role, status }))
      return fail("invalidState");
    const { decision, reasonCode, note } = parsed.data;
    await tx.insert(jobModerationDecision).values({
      jobId: row.id,
      moderatorId: moderator.userId,
      decision,
      reasonCode,
      note,
      decidedAt: now,
    });
    const to = decision === "approved" ? "published" : "rejected";
    await tx
      .update(job)
      .set({
        ...(decision === "approved"
          ? publishValues(now, row.firstPublishedAt)
          : { status: "rejected" as const }),
        updatedAt: now,
      })
      .where(eq(job.id, row.id));
    await event(tx, row.id, moderator.userId, status, to, now);
    await enqueue(
      deps.boss,
      "jobs.notify",
      { jobId: row.id, kind: decision },
      { tx },
    );
    return { ok: true as const };
  });
}
