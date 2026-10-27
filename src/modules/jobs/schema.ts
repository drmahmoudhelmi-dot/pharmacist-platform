import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "@/modules/identity/schema";
import { organization } from "@/modules/organizations/schema";
import { governorate } from "@/modules/profiles/schema";
import type { ApplicationSnapshot } from "./application-snapshot";
import {
  APPLICATION_LIMITS,
  APPLICATION_STATUSES,
  CAREER_STAGES,
  EMPLOYMENT_TYPES,
  JOB_CATEGORIES,
  JOB_STATUSES,
  LIMITS,
  MODERATION_DECISIONS,
  REASON_CODES,
  REJECT_REASONS,
  REMOVE_REASONS,
  REPORT_LIMITS,
  REPORT_REASONS,
  REPORT_STATUSES,
} from "./constants";

// Tables owned by the jobs module (ADR-006). References to other modules:
// `user` (creator, editor, moderator, event actor), `organization` (owner of
// the job) and profiles' `governorate` (integrity only; reads go through the
// owning modules' services). Migration 0008 adds by hand: the pg_trgm
// extension and the search index, the status transition trigger on `job`,
// and the append-only guard on `job_moderation_decision` and `job_event`.

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

const sqlList = (values: readonly string[]) =>
  values.map((v) => `'${v}'`).join(", ");

export const job = pgTable(
  "job",
  {
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    status: text("status", { enum: JOB_STATUSES }).default("draft").notNull(),
    title: text("title").notNull(),
    category: text("category", { enum: JOB_CATEGORIES }).notNull(),
    employmentType: text("employment_type", {
      enum: EMPLOYMENT_TYPES,
    }).notNull(),
    // Temporary positions only (e.g. a temporary pharmacy manager).
    startDate: date("start_date", { mode: "string" }),
    endDate: date("end_date", { mode: "string" }),
    governorateId: smallint("governorate_id")
      .notNull()
      .references(() => governorate.id, { onDelete: "restrict" }),
    area: text("area"),
    description: text("description").notNull(),
    minYearsExperience: smallint("min_years_experience").default(0).notNull(),
    careerStages: text("career_stages", { enum: CAREER_STAGES })
      .array()
      .notNull(),
    // Monthly, in piasters (integer minor units of EGP).
    salaryMin: integer("salary_min"),
    salaryMax: integer("salary_max"),
    // Normalized title and area (src/shared/text/search.ts), written by the
    // service; the trigram index serves the board's search.
    searchText: text("search_text").notNull(),
    createdBy: uuid("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    updatedBy: uuid("updated_by").references(() => user.id, {
      onDelete: "set null",
    }),
    // The member who last submitted it: their verification decides whether
    // moderation is needed, and the board shows it as the poster's badge.
    submittedBy: uuid("submitted_by").references(() => user.id, {
      onDelete: "set null",
    }),
    submittedAt: timestamptz("submitted_at"),
    publishedAt: timestamptz("published_at"),
    firstPublishedAt: timestamptz("first_published_at"),
    expiresAt: timestamptz("expires_at"),
    closedAt: timestamptz("closed_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("job_organization_id_idx").on(table.organizationId, table.createdAt),
    // The public board: published, newest first (keyset on published_at, id).
    index("job_board_idx")
      .on(table.publishedAt, table.id)
      .where(sql`${table.status} = 'published'`),
    // The moderation queue: oldest first.
    index("job_review_queue_idx")
      .on(table.submittedAt)
      .where(sql`${table.status} = 'pending_review'`),
    index("job_governorate_id_idx").on(table.governorateId),
    // The daily expiry pass.
    index("job_expires_at_idx")
      .on(table.expiresAt)
      .where(sql`${table.status} in ('published', 'paused')`),
    check("job_status_check", sql.raw(`status in (${sqlList(JOB_STATUSES)})`)),
    check(
      "job_category_check",
      sql.raw(`category in (${sqlList(JOB_CATEGORIES)})`),
    ),
    check(
      "job_employment_type_check",
      sql.raw(`employment_type in (${sqlList(EMPLOYMENT_TYPES)})`),
    ),
    check(
      "job_title_check",
      sql.raw(
        `char_length(title) between ${LIMITS.title.min} and ${LIMITS.title.max}`,
      ),
    ),
    check(
      "job_area_check",
      sql.raw(`char_length(area) between 1 and ${LIMITS.area.max}`),
    ),
    check(
      "job_description_check",
      sql.raw(
        `char_length(description) between ${LIMITS.description.min} and ${LIMITS.description.max}`,
      ),
    ),
    check(
      "job_min_years_check",
      sql.raw(
        `min_years_experience between ${LIMITS.minYearsExperience.min} and ${LIMITS.minYearsExperience.max}`,
      ),
    ),
    check(
      "job_career_stages_check",
      sql.raw(
        `cardinality(career_stages) between 1 and ${CAREER_STAGES.length} and career_stages <@ array[${sqlList(CAREER_STAGES)}]::text[]`,
      ),
    ),
    check(
      "job_salary_check",
      sql.raw(
        `(salary_min is null or salary_min > 0) and (salary_max is null or salary_max > 0) and (salary_min is null or salary_max is null or salary_max >= salary_min)`,
      ),
    ),
    // Temporary positions carry a period; the others do not.
    check(
      "job_period_check",
      sql.raw(
        `(employment_type = 'temporary' and start_date is not null and end_date is not null and end_date >= start_date) or (employment_type <> 'temporary' and start_date is null and end_date is null)`,
      ),
    ),
    // Status and its timestamps move together.
    check(
      "job_state_check",
      sql.raw(
        `(status in ('draft', 'rejected') or submitted_at is not null)
     and (status not in ('published', 'paused', 'closed', 'expired', 'removed') or (published_at is not null and first_published_at is not null and expires_at is not null))
     and ((status = 'closed') = (closed_at is not null))`,
      ),
    ),
  ],
);

// Append-only (trigger in migration 0008).
export const jobModerationDecision = pgTable(
  "job_moderation_decision",
  {
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => job.id, { onDelete: "cascade" }),
    // The only column a cascaded update may change (to NULL).
    moderatorId: uuid("moderator_id").references(() => user.id, {
      onDelete: "set null",
    }),
    decision: text("decision", { enum: MODERATION_DECISIONS }).notNull(),
    reasonCode: text("reason_code", { enum: REASON_CODES }).notNull(),
    // Internal; never shown to the employer.
    note: text("note"),
    decidedAt: timestamptz("decided_at").defaultNow().notNull(),
  },
  (table) => [
    index("job_moderation_decision_job_id_idx").on(table.jobId),
    check(
      "job_moderation_decision_decision_check",
      sql.raw(`decision in (${sqlList(MODERATION_DECISIONS)})`),
    ),
    check(
      "job_moderation_decision_reason_check",
      sql.raw(
        `(decision = 'approved' and reason_code = 'meets_guidelines') or (decision = 'rejected' and reason_code in (${sqlList(REJECT_REASONS)})) or (decision = 'removed' and reason_code in (${sqlList(REMOVE_REASONS)}))`,
      ),
    ),
    check(
      "job_moderation_decision_note_check",
      sql.raw(`char_length(note) between 1 and ${LIMITS.note.max}`),
    ),
  ],
);

// Append-only history of status changes (trigger in migration 0008).
export const jobEvent = pgTable(
  "job_event",
  {
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => job.id, { onDelete: "cascade" }),
    // Null for the system (the expiry job) or a deleted account.
    actorId: uuid("actor_id").references(() => user.id, {
      onDelete: "set null",
    }),
    fromStatus: text("from_status", { enum: JOB_STATUSES }),
    toStatus: text("to_status", { enum: JOB_STATUSES }).notNull(),
    at: timestamptz("at").defaultNow().notNull(),
  },
  (table) => [
    index("job_event_job_id_idx").on(table.jobId, table.at),
    check(
      "job_event_status_check",
      sql.raw(
        `to_status in (${sqlList(JOB_STATUSES)}) and (from_status is null or from_status in (${sqlList(JOB_STATUSES)}))`,
      ),
    ),
  ],
);

// ---------------------------------------------------------------------------
// Applications (ADR-007). The snapshot, phone and note are what the applicant
// shared with this employer at apply time; the trigger in migration 0009
// keeps them, the job and the applicant immutable and enforces the status
// transitions. `application_event` is append-only.

export const jobApplication = pgTable(
  "job_application",
  {
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    // RESTRICT: a job that ever had applications is never deleted (only
    // never-submitted drafts are, and those cannot be applied to).
    jobId: uuid("job_id")
      .notNull()
      .references(() => job.id, { onDelete: "restrict" }),
    applicantId: uuid("applicant_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status", { enum: APPLICATION_STATUSES })
      .default("submitted")
      .notNull(),
    profileSnapshot: jsonb("profile_snapshot")
      .$type<ApplicationSnapshot>()
      .notNull(),
    // Only when the applicant chose to share it with this employer.
    phoneE164: text("phone_e164"),
    coverNote: text("cover_note"),
    submittedAt: timestamptz("submitted_at").defaultNow().notNull(),
    decidedAt: timestamptz("decided_at"),
    withdrawnAt: timestamptz("withdrawn_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    unique("job_application_job_applicant_key").on(
      table.jobId,
      table.applicantId,
    ),
    index("job_application_applicant_idx").on(
      table.applicantId,
      table.submittedAt,
    ),
    index("job_application_job_idx").on(table.jobId, table.submittedAt),
    check(
      "job_application_status_check",
      sql.raw(`status in (${sqlList(APPLICATION_STATUSES)})`),
    ),
    check(
      "job_application_phone_check",
      sql.raw(`phone_e164 ~ '^\\+201[0125][0-9]{8}$'`),
    ),
    check(
      "job_application_cover_note_check",
      sql.raw(
        `char_length(cover_note) between 1 and ${APPLICATION_LIMITS.coverNote.max}`,
      ),
    ),
    check(
      "job_application_snapshot_check",
      sql.raw(`jsonb_typeof(profile_snapshot) = 'object'`),
    ),
    check(
      "job_application_state_check",
      sql.raw(
        `((status in ('accepted', 'rejected')) = (decided_at is not null)) and ((status = 'withdrawn') = (withdrawn_at is not null))`,
      ),
    ),
  ],
);

export const applicationEvent = pgTable(
  "application_event",
  {
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => jobApplication.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").references(() => user.id, {
      onDelete: "set null",
    }),
    fromStatus: text("from_status", { enum: APPLICATION_STATUSES }),
    toStatus: text("to_status", { enum: APPLICATION_STATUSES }).notNull(),
    at: timestamptz("at").defaultNow().notNull(),
  },
  (table) => [
    index("application_event_application_idx").on(
      table.applicationId,
      table.at,
    ),
    check(
      "application_event_status_check",
      sql.raw(
        `to_status in (${sqlList(APPLICATION_STATUSES)}) and (from_status is null or from_status in (${sqlList(APPLICATION_STATUSES)}))`,
      ),
    ),
  ],
);

// Reports of live jobs by members (ADR-009). Resolution is set once (trigger
// in migration 0011); rows go only with their job. The reporter is shown to
// moderators only.
export const jobReport = pgTable(
  "job_report",
  {
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => job.id, { onDelete: "cascade" }),
    reporterId: uuid("reporter_id").references(() => user.id, {
      onDelete: "set null",
    }),
    reasonCode: text("reason_code", { enum: REPORT_REASONS }).notNull(),
    details: text("details"),
    status: text("status", { enum: REPORT_STATUSES }).default("open").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    resolvedAt: timestamptz("resolved_at"),
    resolvedBy: uuid("resolved_by").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    index("job_report_job_id_idx").on(table.jobId),
    index("job_report_open_idx")
      .on(table.createdAt, table.jobId)
      .where(sql`${table.status} = 'open'`),
    index("job_report_reporter_idx").on(table.reporterId, table.createdAt),
    // One open report per reporter and job.
    uniqueIndex("job_report_open_unique")
      .on(table.jobId, table.reporterId)
      .where(sql`${table.status} = 'open'`),
    check(
      "job_report_reason_check",
      sql.raw(`reason_code in (${sqlList(REPORT_REASONS)})`),
    ),
    check(
      "job_report_status_check",
      sql.raw(
        `(status = 'open' and resolved_at is null) or (status in ('actioned', 'dismissed') and resolved_at is not null)`,
      ),
    ),
    check(
      "job_report_details_check",
      sql.raw(
        `details is null or char_length(details) between 1 and ${REPORT_LIMITS.details.max}`,
      ),
    ),
  ],
);
