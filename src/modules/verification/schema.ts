import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  inet,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "@/modules/identity/schema";
import { upload } from "@/modules/uploads/schema";
import {
  ACCESS_ACTIONS,
  APPROVE_REASONS,
  CREDENTIAL_TYPES,
  DECISIONS,
  DOCUMENT_KINDS,
  EMAIL_LOCALES,
  LIMITS,
  REJECT_REASONS,
  SUBMISSION_STATUSES,
} from "./constants";

// Tables owned by the verification module (ADR-004, 4b). References to other
// modules: `user` (owner, reviewer, actor) and `upload` (the clean photos a
// submission is made of). The uploads module still owns every read of its
// table; the foreign key only guarantees a document never points at a missing
// upload. Two tables are append-only, enforced by triggers added by hand to
// migration 0004 (see the comments there): `verification_decision` and
// `document_access_log`.

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

const sqlList = (values: readonly string[]) =>
  values.map((v) => `'${v}'`).join(", ");

export const verificationSubmission = pgTable(
  "verification_submission",
  {
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    credentialType: text("credential_type", {
      enum: CREDENTIAL_TYPES,
    }).notNull(),
    status: text("status", { enum: SUBMISSION_STATUSES })
      .default("pending")
      .notNull(),
    // Unverified claims, stored as submitted (normalized).
    syndicateNumber: text("syndicate_number"),
    university: text("university"),
    // Optional expiry date printed on the syndicate or student card.
    cardExpiresOn: date("card_expires_on", { mode: "string" }),
    // `v1.<keyId>.<iv>.<ciphertext>.<tag>` (src/shared/crypto). Never selected
    // except by the reviewer's reveal.
    nationalIdCiphertext: text("national_id_ciphertext").notNull(),
    // HMAC-SHA256 (hex) of the national ID under NATIONAL_ID_HASH_KEY.
    nationalIdHash: text("national_id_hash").notNull(),
    // `2**********345`
    nationalIdMasked: text("national_id_masked").notNull(),
    // Id of the encryption key, for rotation (also inside the ciphertext).
    keyId: text("key_id").notNull(),
    // Version of the consent text accepted with this submission.
    consentVersion: text("consent_version").notNull(),
    // Language for the emails about this submission.
    locale: text("locale", { enum: EMAIL_LOCALES }).default("ar").notNull(),
    submittedAt: timestamptz("submitted_at").defaultNow().notNull(),
    decidedAt: timestamptz("decided_at"),
    expiredAt: timestamptz("expired_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("verification_submission_user_id_idx").on(
      table.userId,
      table.submittedAt,
    ),
    // The reviewer queue: pending, oldest first.
    index("verification_submission_queue_idx")
      .on(table.submittedAt)
      .where(sql`${table.status} = 'pending'`),
    // At most one pending submission per user.
    uniqueIndex("verification_submission_one_pending_idx")
      .on(table.userId)
      .where(sql`${table.status} = 'pending'`),
    // One national ID backs at most one pending or verified submission. A user
    // holds at most one pending submission and cannot submit while verified,
    // so the only way to collide is a second account with the same ID; a
    // rejected or expired submission frees the ID (also for its own user).
    uniqueIndex("verification_submission_national_id_active_idx")
      .on(table.nationalIdHash)
      .where(sql`${table.status} in ('pending', 'verified')`),
    check(
      "verification_submission_credential_type_check",
      sql.raw(`${table.credentialType.name} in (${sqlList(CREDENTIAL_TYPES)})`),
    ),
    check(
      "verification_submission_status_check",
      sql.raw(`${table.status.name} in (${sqlList(SUBMISSION_STATUSES)})`),
    ),
    check(
      "verification_submission_locale_check",
      sql.raw(`${table.locale.name} in (${sqlList(EMAIL_LOCALES)})`),
    ),
    // Pharmacists give a syndicate number, students a university; never both.
    check(
      "verification_submission_claims_check",
      sql`(${table.credentialType} = 'pharmacist' and ${table.syndicateNumber} is not null and ${table.university} is null)
       or (${table.credentialType} = 'student' and ${table.university} is not null and ${table.syndicateNumber} is null)`,
    ),
    check(
      "verification_submission_syndicate_number_check",
      sql.raw(
        `syndicate_number ~ '^[0-9]{${LIMITS.syndicateNumber.min},${LIMITS.syndicateNumber.max}}$'`,
      ),
    ),
    check(
      "verification_submission_university_check",
      sql.raw(
        `char_length(university) between ${LIMITS.university.min} and ${LIMITS.university.max}`,
      ),
    ),
    check(
      "verification_submission_national_id_masked_check",
      sql`${table.nationalIdMasked} ~ '^[23][*]{10}[0-9]{3}$'`,
    ),
    check(
      "verification_submission_national_id_hash_check",
      sql`${table.nationalIdHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "verification_submission_national_id_ciphertext_check",
      sql`${table.nationalIdCiphertext} ~ '^v1[.][0-9a-f]{16}[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$'`,
    ),
    check(
      "verification_submission_key_id_check",
      sql`${table.keyId} ~ '^[0-9a-f]{16}$'`,
    ),
    check(
      "verification_submission_consent_version_check",
      sql`char_length(${table.consentVersion}) between 1 and 64`,
    ),
    // Status and its timestamps move together.
    check(
      "verification_submission_state_check",
      sql`(${table.status} = 'pending' and ${table.decidedAt} is null and ${table.expiredAt} is null)
       or (${table.status} in ('verified', 'rejected') and ${table.decidedAt} is not null and ${table.expiredAt} is null)
       or (${table.status} = 'expired' and ${table.decidedAt} is not null and ${table.expiredAt} is not null and ${table.cardExpiresOn} is not null)`,
    ),
  ],
);

export const verificationDocument = pgTable(
  "verification_document",
  {
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => verificationSubmission.id, { onDelete: "cascade" }),
    // NO ACTION, made DEFERRABLE INITIALLY DEFERRED by hand in migration 0004
    // (drizzle-kit cannot express it): deleting a user, which cascades to both
    // the upload and the submission, succeeds; deleting an upload that a
    // submission still uses fails at commit.
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => upload.id),
    kind: text("kind", { enum: DOCUMENT_KINDS }).notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    unique("verification_document_submission_kind_unique").on(
      table.submissionId,
      table.kind,
    ),
    // A photo backs one document of one submission only.
    unique("verification_document_upload_unique").on(table.uploadId),
    check(
      "verification_document_kind_check",
      sql.raw(`${table.kind.name} in (${sqlList(DOCUMENT_KINDS)})`),
    ),
  ],
);

/** Append-only: one row per decision; the submission's status follows it. */
export const verificationDecision = pgTable(
  "verification_decision",
  {
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    // One decision per submission: a second, concurrent decision fails here
    // even if the service's row lock were bypassed.
    submissionId: uuid("submission_id")
      .notNull()
      .unique()
      .references(() => verificationSubmission.id, { onDelete: "cascade" }),
    // Kept when the reviewer's account is deleted, as "unknown reviewer".
    reviewerId: uuid("reviewer_id").references(() => user.id, {
      onDelete: "set null",
    }),
    decision: text("decision", { enum: DECISIONS }).notNull(),
    reasonCode: text("reason_code").notNull(),
    // Internal note for staff; never shown to the user.
    note: text("note"),
    decidedAt: timestamptz("decided_at").defaultNow().notNull(),
  },
  (table) => [
    check(
      "verification_decision_decision_check",
      sql.raw(`${table.decision.name} in (${sqlList(DECISIONS)})`),
    ),
    check(
      "verification_decision_reason_check",
      sql.raw(
        `(decision = 'verified' and reason_code in (${sqlList(APPROVE_REASONS)}))
       or (decision = 'rejected' and reason_code in (${sqlList(REJECT_REASONS)}))`,
      ),
    ),
    check(
      "verification_decision_note_check",
      sql.raw(`char_length(note) between 1 and ${LIMITS.note.max}`),
    ),
  ],
);

/**
 * Append-only: every document view (a signed URL issued to a reviewer) and
 * every reveal of a decrypted national ID. No document contents and no ID
 * values, only who, what, when and from where.
 */
export const documentAccessLog = pgTable(
  "document_access_log",
  {
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => verificationSubmission.id, { onDelete: "cascade" }),
    // Set for `view`, null for `reveal_national_id`.
    documentId: uuid("document_id").references(() => verificationDocument.id, {
      onDelete: "cascade",
    }),
    actorId: uuid("actor_id").references(() => user.id, {
      onDelete: "set null",
    }),
    action: text("action", { enum: ACCESS_ACTIONS }).notNull(),
    at: timestamptz("at").defaultNow().notNull(),
    ip: inet("ip"),
  },
  (table) => [
    index("document_access_log_submission_id_idx").on(
      table.submissionId,
      table.at,
    ),
    index("document_access_log_document_id_idx").on(table.documentId),
    index("document_access_log_actor_id_idx").on(table.actorId, table.at),
    check(
      "document_access_log_action_check",
      sql.raw(`${table.action.name} in (${sqlList(ACCESS_ACTIONS)})`),
    ),
    check(
      "document_access_log_target_check",
      sql`(${table.action} = 'view') = (${table.documentId} is not null)`,
    ),
  ],
);
