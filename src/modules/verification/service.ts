import "server-only";
import { isIP } from "node:net";
import { and, asc, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Logger } from "pino";
import { recordAudit } from "@/modules/admin/audit";
import type { Actor } from "@/modules/identity/policy";
import {
  findOwnUploads,
  issueSignedUrl,
  isUuid,
  type UploadDeps,
} from "@/modules/uploads/service";
import { enqueue, type PgBoss } from "@/shared/jobs/boss";
import {
  CONSENT_VERSION,
  type CredentialType,
  type Decision,
  type DocumentKind,
  type EmailLocale,
  isCredentialType,
  isDecision,
  isDocumentKind,
  isReasonCode,
  isRejectReason,
  isSubmissionStatus,
  LIMITS,
  type ReasonCode,
  type RejectReason,
  REQUIRED_DOCUMENTS,
  type SubmissionStatus,
  type VerificationState,
} from "./constants";
import {
  decryptNationalId,
  encryptNationalId,
  hashNationalId,
  type NationalIdKeys,
} from "./keys";
import { maskNationalId } from "./national-id";
import { can } from "./policy";
import {
  documentAccessLog,
  verificationDecision,
  verificationDocument,
  verificationSubmission,
} from "./schema";
import {
  type DecisionField,
  type FieldErrors,
  parseDecision,
  parseSubmission,
  type RawForm,
  type SubmissionField,
} from "./validation";

// All database access for professional verification (ADR-004, 4b), on behalf
// of a user or a reviewer. Every function takes the Actor built from the
// session; owner ids always come from `actor.userId`, never from input.
//
// The national ID never leaves this module in clear text except through
// `revealNationalId`, which logs the reveal first. Results carry the masked
// form only; ciphertext, hash and key id are never selected for a result.
// Worker-side code (emails, expiry) is in jobs.ts.

type Db = NodePgDatabase;

export type VerificationDeps = {
  db: Db;
  boss: PgBoss;
  logger: Logger;
  keys: NationalIdKeys;
  now?: () => Date;
};

const nowOf = (deps: { now?: () => Date }) => deps.now?.() ?? new Date();

/** A client IP fit for the `inet` column, or null. */
export function normalizeIp(value: string | null | undefined): string | null {
  const first = value?.split(",")[0]?.trim() ?? "";
  return first !== "" && isIP(first) !== 0 ? first : null;
}

/** The constraint a database error violated, through Drizzle's wrapper. */
function violatedConstraint(error: unknown): string | null {
  for (let e: unknown = error, i = 0; e && i < 3; i++) {
    const candidate = e as {
      code?: string;
      constraint?: string;
      cause?: unknown;
    };
    if (candidate.code === "23505" && candidate.constraint)
      return candidate.constraint;
    e = candidate.cause;
  }
  return null;
}

const lockUser = (tx: Pick<Db, "execute">, userId: string) =>
  tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`verification:${userId}`}, 0))`,
  );

// ---------------------------------------------------------------------------
// Submitting

export type SubmitError =
  | "forbidden"
  | "validation"
  | "already_pending"
  | "already_verified"
  | "national_id_in_use";

export type SubmitResult =
  | {
      ok: true;
      submission: { id: string; status: "pending"; nationalIdMasked: string };
    }
  | {
      ok: false;
      error: SubmitError;
      fieldErrors?: FieldErrors<SubmissionField>;
    };

/**
 * Records a verification request: validates the claims and national ID,
 * checks that every required photo is one of the actor's own clean
 * verification uploads (through the uploads service), encrypts the ID and
 * stores the submission, its documents and the "received" email job in one
 * transaction. Serialized per user, so double submits cannot both pass.
 *
 * A national ID already backing another account's pending or verified
 * submission answers `national_id_in_use` and nothing more.
 */
export async function submitVerification(
  deps: VerificationDeps,
  actor: Actor,
  raw: RawForm,
  locale: EmailLocale = "ar",
): Promise<SubmitResult> {
  if (!can(actor, "verification.submit", { ownerId: actor.userId }))
    return { ok: false, error: "forbidden" };
  const now = nowOf(deps);
  const parsed = parseSubmission(raw, now);
  if (!parsed.ok)
    return { ok: false, error: "validation", fieldErrors: parsed.fieldErrors };
  const input = parsed.data;
  const nationalId = input.nationalId.value;
  const hash = hashNationalId(deps.keys, nationalId);
  const masked = maskNationalId(nationalId);
  const kinds = REQUIRED_DOCUMENTS[input.credentialType];

  type Outcome =
    | SubmitResult
    | {
        ok: false;
        error: "validation";
        fieldErrors: FieldErrors<SubmissionField>;
      };

  let outcome: Outcome;
  try {
    outcome = await deps.db.transaction(async (tx): Promise<Outcome> => {
      await lockUser(tx, actor.userId);
      const [latest] = await tx
        .select({ status: verificationSubmission.status })
        .from(verificationSubmission)
        .where(eq(verificationSubmission.userId, actor.userId))
        .orderBy(desc(verificationSubmission.submittedAt))
        .limit(1);
      if (latest?.status === "pending")
        return { ok: false, error: "already_pending" };
      if (latest?.status === "verified")
        return { ok: false, error: "already_verified" };

      // Each photo: the actor's own, for verification, clean, and not already
      // part of another submission.
      const ids = kinds.map((k) => input.documents[k]);
      const own = new Map(
        (await findOwnUploads(tx, actor, ids, "verification_document")).map(
          (u) => [u.id, u.status],
        ),
      );
      const used = new Set(
        (
          await tx
            .select({ uploadId: verificationDocument.uploadId })
            .from(verificationDocument)
            .where(
              inArray(
                verificationDocument.uploadId,
                ids.filter((id): id is string => id !== undefined),
              ),
            )
        ).map((r) => r.uploadId),
      );
      const fieldErrors: FieldErrors<SubmissionField> = {};
      const seen = new Set<string>();
      for (const kind of kinds) {
        const id = input.documents[kind];
        const status = id ? own.get(id) : undefined;
        if (!id || !status) fieldErrors[kind] = "documentNotFound";
        else if (seen.has(id) || used.has(id))
          fieldErrors[kind] = "documentInUse";
        else if (status === "processing")
          fieldErrors[kind] = "documentProcessing";
        else if (status === "rejected") fieldErrors[kind] = "documentRejected";
        if (id) seen.add(id);
      }
      if (Object.keys(fieldErrors).length > 0)
        return { ok: false, error: "validation", fieldErrors };

      // Another account's pending or verified submission with this ID. The
      // unique index enforces it too; this gives the same answer without
      // relying on the error.
      const [taken] = await tx
        .select({ id: verificationSubmission.id })
        .from(verificationSubmission)
        .where(
          and(
            eq(verificationSubmission.nationalIdHash, hash),
            inArray(verificationSubmission.status, ["pending", "verified"]),
            ne(verificationSubmission.userId, actor.userId),
          ),
        )
        .limit(1);
      if (taken) return { ok: false, error: "national_id_in_use" };

      const encrypted = encryptNationalId(deps.keys, actor.userId, nationalId);
      const [row] = await tx
        .insert(verificationSubmission)
        .values({
          userId: actor.userId,
          credentialType: input.credentialType,
          legalNameAr: input.legalNameAr,
          syndicateNumber: input.syndicateNumber,
          university: input.university,
          cardExpiresOn: input.cardExpiresOn,
          nationalIdCiphertext: encrypted.ciphertext,
          nationalIdHash: hash,
          nationalIdMasked: masked,
          keyId: encrypted.keyId,
          consentVersion: CONSENT_VERSION,
          locale,
          submittedAt: now,
        })
        .returning({ id: verificationSubmission.id });
      if (!row) throw new Error("submission insert returned no row");
      await tx.insert(verificationDocument).values(
        kinds.map((kind) => ({
          submissionId: row.id,
          uploadId: input.documents[kind] as string,
          kind,
        })),
      );
      await enqueue(
        deps.boss,
        "verification.notify",
        { submissionId: row.id, kind: "received" },
        { tx },
      );
      return {
        ok: true,
        submission: { id: row.id, status: "pending", nationalIdMasked: masked },
      };
    });
  } catch (error) {
    // The serialization above makes these unreachable in normal operation;
    // they are the database's backstop for the same rules.
    const constraint = violatedConstraint(error);
    if (constraint === "verification_submission_national_id_active_idx")
      return { ok: false, error: "national_id_in_use" };
    if (constraint === "verification_submission_one_pending_idx")
      return { ok: false, error: "already_pending" };
    throw error;
  }
  if (outcome.ok)
    deps.logger.info({
      event: "verification.submitted",
      submissionId: outcome.submission.id,
      userId: actor.userId,
      credentialType: input.credentialType,
    });
  return outcome;
}

// ---------------------------------------------------------------------------
// The user's own status

export type MyVerification = {
  state: VerificationState;
  /** True when a new submission would be accepted (unverified, rejected, expired). */
  canSubmit: boolean;
  credentialType: CredentialType | null;
  nationalIdMasked: string | null;
  submittedAt: Date | null;
  decidedAt: Date | null;
  cardExpiresOn: string | null;
  /** Only for `rejected`: the reason code the UI localizes. */
  rejectionReason: RejectReason | null;
};

const UNVERIFIED: MyVerification = {
  state: "unverified",
  canSubmit: true,
  credentialType: null,
  nationalIdMasked: null,
  submittedAt: null,
  decidedAt: null,
  cardExpiresOn: null,
  rejectionReason: null,
};

/** The latest submission's state for the owner. Never the ciphertext or hash. */
export async function getMyVerificationStatus(
  db: Db,
  actor: Actor,
): Promise<MyVerification | null> {
  if (!can(actor, "verification.readOwn", { ownerId: actor.userId }))
    return null;
  const [row] = await db
    .select({
      status: verificationSubmission.status,
      credentialType: verificationSubmission.credentialType,
      nationalIdMasked: verificationSubmission.nationalIdMasked,
      submittedAt: verificationSubmission.submittedAt,
      decidedAt: verificationSubmission.decidedAt,
      cardExpiresOn: verificationSubmission.cardExpiresOn,
      reasonCode: verificationDecision.reasonCode,
    })
    .from(verificationSubmission)
    .leftJoin(
      verificationDecision,
      eq(verificationDecision.submissionId, verificationSubmission.id),
    )
    .where(eq(verificationSubmission.userId, actor.userId))
    .orderBy(desc(verificationSubmission.submittedAt))
    .limit(1);
  if (!row || !isSubmissionStatus(row.status)) return UNVERIFIED;
  return {
    state: row.status,
    canSubmit: row.status === "rejected" || row.status === "expired",
    credentialType: isCredentialType(row.credentialType)
      ? row.credentialType
      : null,
    nationalIdMasked: row.nationalIdMasked,
    submittedAt: row.submittedAt,
    decidedAt: row.decidedAt,
    cardExpiresOn: row.cardExpiresOn,
    rejectionReason:
      row.status === "rejected" && isRejectReason(row.reasonCode)
        ? row.reasonCode
        : null,
  };
}

/**
 * The verified badge for profiles (and later jobs): `verified` only when the
 * user's latest submission is verified. Pending, rejected, expired and no
 * submission all give null. Submission is not proof.
 */
export async function getVerificationBadge(
  db: Db,
  userId: string,
): Promise<"verified" | null> {
  if (!isUuid(userId)) return null;
  const [row] = await db
    .select({ status: verificationSubmission.status })
    .from(verificationSubmission)
    .where(eq(verificationSubmission.userId, userId))
    .orderBy(desc(verificationSubmission.submittedAt))
    .limit(1);
  return row?.status === "verified" ? "verified" : null;
}

/**
 * Of these users, the ones whose latest submission is verified (the same rule
 * as getVerificationBadge), in one query: for lists such as the job board.
 */
export async function getVerifiedUserIds(
  db: Db,
  userIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(userIds)].filter(isUuid);
  if (ids.length === 0) return new Set();
  const rows = await db
    .selectDistinctOn([verificationSubmission.userId], {
      userId: verificationSubmission.userId,
      status: verificationSubmission.status,
    })
    .from(verificationSubmission)
    .where(inArray(verificationSubmission.userId, ids))
    .orderBy(
      verificationSubmission.userId,
      desc(verificationSubmission.submittedAt),
    );
  return new Set(
    rows.filter((r) => r.status === "verified").map((r) => r.userId),
  );
}

export type VerificationExportItem = {
  credentialType: string;
  status: string;
  /** The legal name in Arabic the user entered (their own data). */
  legalNameAr: string;
  nationalIdMasked: string;
  syndicateNumber: string | null;
  university: string | null;
  cardExpiresOn: string | null;
  consentVersion: string;
  submittedAt: string;
  decidedAt: string | null;
  expiredAt: string | null;
  documents: string[];
  decision: { decision: string; reasonCode: string; decidedAt: string } | null;
};

/**
 * The verification part of the user's data export: every submission with
 * its status, legal name, claims, masked ID, document kinds and decision. Never the
 * ciphertext, hash, key id, photos or the reviewer's identity and internal
 * note (whether the note belongs in an access request is a question for
 * counsel; see data-protection-status.md).
 */
export async function exportOwnVerification(
  db: Db,
  actor: Actor,
): Promise<VerificationExportItem[] | null> {
  if (!can(actor, "verification.readOwn", { ownerId: actor.userId }))
    return null;
  const rows = await db
    .select({
      id: verificationSubmission.id,
      credentialType: verificationSubmission.credentialType,
      status: verificationSubmission.status,
      legalNameAr: verificationSubmission.legalNameAr,
      nationalIdMasked: verificationSubmission.nationalIdMasked,
      syndicateNumber: verificationSubmission.syndicateNumber,
      university: verificationSubmission.university,
      cardExpiresOn: verificationSubmission.cardExpiresOn,
      consentVersion: verificationSubmission.consentVersion,
      submittedAt: verificationSubmission.submittedAt,
      decidedAt: verificationSubmission.decidedAt,
      expiredAt: verificationSubmission.expiredAt,
      decision: verificationDecision.decision,
      reasonCode: verificationDecision.reasonCode,
      decisionAt: verificationDecision.decidedAt,
    })
    .from(verificationSubmission)
    .leftJoin(
      verificationDecision,
      eq(verificationDecision.submissionId, verificationSubmission.id),
    )
    .where(eq(verificationSubmission.userId, actor.userId))
    .orderBy(asc(verificationSubmission.submittedAt));
  const docs =
    rows.length === 0
      ? []
      : await db
          .select({
            submissionId: verificationDocument.submissionId,
            kind: verificationDocument.kind,
          })
          .from(verificationDocument)
          .where(
            inArray(
              verificationDocument.submissionId,
              rows.map((r) => r.id),
            ),
          );
  return rows.map((r) => ({
    credentialType: r.credentialType,
    status: r.status,
    legalNameAr: r.legalNameAr,
    nationalIdMasked: r.nationalIdMasked,
    syndicateNumber: r.syndicateNumber,
    university: r.university,
    cardExpiresOn: r.cardExpiresOn,
    consentVersion: r.consentVersion,
    submittedAt: r.submittedAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    expiredAt: r.expiredAt?.toISOString() ?? null,
    documents: docs
      .filter((d) => d.submissionId === r.id)
      .map((d) => d.kind)
      .sort(),
    decision:
      r.decision && r.reasonCode && r.decisionAt
        ? {
            decision: r.decision,
            reasonCode: r.reasonCode,
            decidedAt: r.decisionAt.toISOString(),
          }
        : null,
  }));
}

// ---------------------------------------------------------------------------
// Reviewer queue

/**
 * Number of pending submissions this reviewer may review (same filter as
 * `listQueue`: their own submission is left out); null if not a reviewer.
 */
export async function countPendingVerifications(
  db: Db,
  reviewer: Actor,
): Promise<number | null> {
  if (!can(reviewer, "verification.queue")) return null;
  const [row] = await db
    .select({ n: count() })
    .from(verificationSubmission)
    .where(
      and(
        eq(verificationSubmission.status, "pending"),
        ne(verificationSubmission.userId, reviewer.userId),
      ),
    );
  return row?.n ?? 0;
}

export type QueueItem = {
  id: string;
  credentialType: CredentialType;
  /** Legal name in Arabic as on the national ID (reviewer-only). */
  legalNameAr: string;
  nationalIdMasked: string;
  submittedAt: Date;
};

export type QueuePage = { items: QueueItem[]; page: number; hasMore: boolean };

/**
 * Pending submissions, oldest first, masked ID and legal name only. The reviewer's own
 * submission is left out (they may not review it). Offset pages: the queue is
 * a small staff table (database reference, "Queries and pagination").
 */
export async function listQueue(
  db: Db,
  reviewer: Actor,
  page: unknown = 1,
): Promise<QueuePage | null> {
  if (!can(reviewer, "verification.queue")) return null;
  const n = Number(page);
  const current = Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 1;
  const size = LIMITS.queuePageSize;
  const rows = await db
    .select({
      id: verificationSubmission.id,
      credentialType: verificationSubmission.credentialType,
      legalNameAr: verificationSubmission.legalNameAr,
      nationalIdMasked: verificationSubmission.nationalIdMasked,
      submittedAt: verificationSubmission.submittedAt,
    })
    .from(verificationSubmission)
    .where(
      and(
        eq(verificationSubmission.status, "pending"),
        ne(verificationSubmission.userId, reviewer.userId),
      ),
    )
    .orderBy(
      asc(verificationSubmission.submittedAt),
      asc(verificationSubmission.id),
    )
    .limit(size + 1)
    .offset((current - 1) * size);
  return {
    items: rows
      .slice(0, size)
      .flatMap((r) =>
        isCredentialType(r.credentialType)
          ? [{ ...r, credentialType: r.credentialType }]
          : [],
      ),
    page: current,
    hasMore: rows.length > size,
  };
}

export type ReviewDetails = {
  id: string;
  credentialType: CredentialType;
  status: SubmissionStatus;
  /** Legal name in Arabic as the user typed it from the national ID card. */
  legalNameAr: string;
  nationalIdMasked: string;
  syndicateNumber: string | null;
  university: string | null;
  cardExpiresOn: string | null;
  submittedAt: Date;
  documents: { id: string; kind: DocumentKind }[];
  decision: {
    decision: Decision;
    reasonCode: ReasonCode;
    note: string | null;
    decidedAt: Date;
    byMe: boolean;
  } | null;
};

/**
 * One submission for a reviewer, with the legal name to compare with the
 * card, masked ID only (the clear value needs an
 * explicit, logged `revealNationalId`). Null when missing, malformed, the
 * reviewer's own, or the caller is not a reviewer.
 */
export async function getSubmissionForReview(
  db: Db,
  reviewer: Actor,
  id: unknown,
): Promise<ReviewDetails | null> {
  if (!isUuid(id) || !can(reviewer, "verification.queue")) return null;
  const [row] = await db
    .select({
      id: verificationSubmission.id,
      userId: verificationSubmission.userId,
      credentialType: verificationSubmission.credentialType,
      status: verificationSubmission.status,
      legalNameAr: verificationSubmission.legalNameAr,
      nationalIdMasked: verificationSubmission.nationalIdMasked,
      syndicateNumber: verificationSubmission.syndicateNumber,
      university: verificationSubmission.university,
      cardExpiresOn: verificationSubmission.cardExpiresOn,
      submittedAt: verificationSubmission.submittedAt,
      decision: verificationDecision.decision,
      reasonCode: verificationDecision.reasonCode,
      note: verificationDecision.note,
      decidedAt: verificationDecision.decidedAt,
      reviewerId: verificationDecision.reviewerId,
    })
    .from(verificationSubmission)
    .leftJoin(
      verificationDecision,
      eq(verificationDecision.submissionId, verificationSubmission.id),
    )
    .where(eq(verificationSubmission.id, id))
    .limit(1);
  if (
    !row ||
    !isSubmissionStatus(row.status) ||
    !isCredentialType(row.credentialType) ||
    !can(reviewer, "verification.read", {
      ownerId: row.userId,
      status: row.status,
    })
  )
    return null;
  const documents = await db
    .select({ id: verificationDocument.id, kind: verificationDocument.kind })
    .from(verificationDocument)
    .where(eq(verificationDocument.submissionId, row.id));
  const order = REQUIRED_DOCUMENTS[row.credentialType];
  return {
    id: row.id,
    credentialType: row.credentialType,
    status: row.status,
    legalNameAr: row.legalNameAr,
    nationalIdMasked: row.nationalIdMasked,
    syndicateNumber: row.syndicateNumber,
    university: row.university,
    cardExpiresOn: row.cardExpiresOn,
    submittedAt: row.submittedAt,
    documents: documents
      .flatMap((d) =>
        isDocumentKind(d.kind) ? [{ id: d.id, kind: d.kind }] : [],
      )
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)),
    decision:
      isDecision(row.decision) && isReasonCode(row.reasonCode) && row.decidedAt
        ? {
            decision: row.decision,
            reasonCode: row.reasonCode,
            note: row.note,
            decidedAt: row.decidedAt,
            byMe: row.reviewerId === reviewer.userId,
          }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Logged access to private data

/** Locks the submission against a concurrent decision while access is granted. */
async function lockForAccess(tx: Pick<Db, "select">, submissionId: string) {
  const [row] = await tx
    .select({
      id: verificationSubmission.id,
      userId: verificationSubmission.userId,
      status: verificationSubmission.status,
      nationalIdCiphertext: verificationSubmission.nationalIdCiphertext,
    })
    .from(verificationSubmission)
    .where(eq(verificationSubmission.id, submissionId))
    .for("share")
    .limit(1);
  return row ?? null;
}

export type RevealResult =
  { ok: true; nationalId: string } | { ok: false; error: "not_found" };

/**
 * The decrypted national ID of a pending submission, for a reviewer who is not
 * its owner. The reveal is written to `document_access_log` in the same
 * transaction as the check, before the value is returned; anything else (not
 * a reviewer, own submission, decided, missing) answers `not_found`.
 */
export async function revealNationalId(
  deps: Pick<VerificationDeps, "db" | "keys" | "logger">,
  reviewer: Actor,
  submissionId: unknown,
  ip: string | null,
): Promise<RevealResult> {
  const notFound = { ok: false, error: "not_found" } as const;
  if (!isUuid(submissionId) || !can(reviewer, "verification.queue"))
    return notFound;
  const value = await deps.db.transaction(async (tx) => {
    const row = await lockForAccess(tx, submissionId);
    if (
      !row ||
      !isSubmissionStatus(row.status) ||
      !can(reviewer, "verification.revealNationalId", {
        ownerId: row.userId,
        status: row.status,
      })
    )
      return null;
    await tx.insert(documentAccessLog).values({
      submissionId: row.id,
      actorId: reviewer.userId,
      action: "reveal_national_id",
      ip: normalizeIp(ip),
    });
    // Throws (rolling back the log row) if the key is gone or the value was
    // tampered with; the error carries no detail.
    return decryptNationalId(deps.keys, row.userId, row.nationalIdCiphertext);
  });
  if (value === null) return notFound;
  deps.logger.info({
    event: "verification.national_id_revealed",
    submissionId,
    actorId: reviewer.userId,
  });
  return { ok: true, nationalId: value };
}

export type ViewResult =
  | { ok: true; url: string; expiresInSeconds: number }
  | { ok: false; error: "not_found" };

/**
 * A 5-minute signed URL for one document of a pending submission, for a
 * reviewer who is not its owner. The uploads service calls the authorizer
 * right before presigning; the authorizer locks the submission, re-checks the
 * policy and writes the `view` row in one transaction, so every URL issued
 * has its log row and a decided submission's documents cannot be opened.
 */
export async function viewDocument(
  deps: Pick<UploadDeps, "db" | "store" | "logger">,
  reviewer: Actor,
  documentId: unknown,
  ip: string | null,
): Promise<ViewResult> {
  const notFound = { ok: false, error: "not_found" } as const;
  if (!isUuid(documentId) || !can(reviewer, "verification.queue"))
    return notFound;
  const [doc] = await deps.db
    .select({
      id: verificationDocument.id,
      submissionId: verificationDocument.submissionId,
      uploadId: verificationDocument.uploadId,
      ownerId: verificationSubmission.userId,
      status: verificationSubmission.status,
    })
    .from(verificationDocument)
    .innerJoin(
      verificationSubmission,
      eq(verificationSubmission.id, verificationDocument.submissionId),
    )
    .where(eq(verificationDocument.id, documentId))
    .limit(1);
  if (
    !doc ||
    !isSubmissionStatus(doc.status) ||
    !can(reviewer, "verification.viewDocument", {
      ownerId: doc.ownerId,
      status: doc.status,
    })
  )
    return notFound;

  const result = await issueSignedUrl(deps, reviewer, {
    uploadId: doc.uploadId,
    purpose: "verification_document",
    authorize: (actor, request) => {
      if (request.uploadId !== doc.uploadId || request.ownerId !== doc.ownerId)
        return false;
      return deps.db.transaction(async (tx) => {
        const row = await lockForAccess(tx, doc.submissionId);
        if (
          !row ||
          row.userId !== request.ownerId ||
          !isSubmissionStatus(row.status) ||
          !can(actor, "verification.viewDocument", {
            ownerId: row.userId,
            status: row.status,
          })
        )
          return false;
        await tx.insert(documentAccessLog).values({
          submissionId: doc.submissionId,
          documentId: doc.id,
          actorId: actor.userId,
          action: "view",
          ip: normalizeIp(ip),
        });
        return true;
      });
    },
  });
  if (!result.ok) return notFound;
  deps.logger.info({
    event: "verification.document_viewed",
    documentId: doc.id,
    submissionId: doc.submissionId,
    actorId: reviewer.userId,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Decisions

export type DecideError =
  "forbidden" | "not_found" | "not_pending" | "validation";

export type DecideResult =
  | { ok: true; status: "verified" | "rejected" }
  | {
      ok: false;
      error: DecideError;
      fieldErrors?: FieldErrors<DecisionField>;
    };

/**
 * Approves or rejects a pending submission. The submission row is locked
 * (FOR UPDATE) while the decision is recorded and the status changes, so of
 * two reviewers deciding at once exactly one wins and the other gets
 * `not_pending` (the unique decision per submission is the database's
 * backstop). The user's email job is enqueued in the same transaction.
 */
export async function decide(
  deps: Pick<VerificationDeps, "db" | "boss" | "logger" | "now">,
  reviewer: Actor,
  submissionId: unknown,
  raw: RawForm,
  ip: string | null = null,
): Promise<DecideResult> {
  if (!can(reviewer, "verification.queue"))
    return { ok: false, error: "forbidden" };
  if (!isUuid(submissionId)) return { ok: false, error: "not_found" };
  const parsed = parseDecision(raw);
  if (!parsed.ok)
    return { ok: false, error: "validation", fieldErrors: parsed.fieldErrors };
  const { decision, reasonCode, note } = parsed.data;
  const now = nowOf(deps);

  let result: DecideResult;
  try {
    result = await deps.db.transaction(async (tx): Promise<DecideResult> => {
      const [row] = await tx
        .select({
          userId: verificationSubmission.userId,
          status: verificationSubmission.status,
        })
        .from(verificationSubmission)
        .where(eq(verificationSubmission.id, submissionId))
        .for("update")
        .limit(1);
      if (!row) return { ok: false, error: "not_found" };
      if (row.userId === reviewer.userId)
        return { ok: false, error: "forbidden" };
      if (row.status !== "pending") return { ok: false, error: "not_pending" };
      if (
        !can(reviewer, "verification.decide", {
          ownerId: row.userId,
          status: row.status,
        })
      )
        return { ok: false, error: "forbidden" };
      // The admin audit log (ADR-008), in the decision's transaction.
      await recordAudit(tx, {
        actorId: reviewer.userId,
        actorKind: "staff",
        action: "verification.decided",
        targetType: "verification_submission",
        targetId: submissionId,
        detail: { decision, reasonCode },
        ip,
      });
      await tx.insert(verificationDecision).values({
        submissionId,
        reviewerId: reviewer.userId,
        decision,
        reasonCode,
        note,
        decidedAt: now,
      });
      await tx
        .update(verificationSubmission)
        .set({ status: decision, decidedAt: now, updatedAt: now })
        .where(
          and(
            eq(verificationSubmission.id, submissionId),
            eq(verificationSubmission.status, "pending"),
          ),
        );
      await enqueue(
        deps.boss,
        "verification.notify",
        { submissionId, kind: decision },
        { tx },
      );
      return { ok: true, status: decision };
    });
  } catch (error) {
    if (
      violatedConstraint(error) === "verification_decision_submission_id_unique"
    )
      return { ok: false, error: "not_pending" };
    throw error;
  }
  if (result.ok)
    deps.logger.info({
      event: "verification.decided",
      submissionId,
      reviewerId: reviewer.userId,
      decision,
      reasonCode,
    });
  return result;
}
