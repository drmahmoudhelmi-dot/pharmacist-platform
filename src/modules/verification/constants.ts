// Allowed values and limits for professional verification (ADR-004, 4b). Free
// of imports so the schema, policy, services, worker and UI can all share them.

export const CREDENTIAL_TYPES = ["pharmacist", "student"] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

/**
 * `pending` → `verified` | `rejected` (reviewer only); `verified` → `expired`
 * (daily job, when the card expiry date the user gave has passed). No row at
 * all means unverified.
 */
export const SUBMISSION_STATUSES = [
  "pending",
  "verified",
  "rejected",
  "expired",
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

/** What the user sees: the submission status, or `unverified` without one. */
export type VerificationState = "unverified" | SubmissionStatus;

export const DOCUMENT_KINDS = [
  "national_id_front",
  "national_id_back",
  "syndicate_card",
  "student_card",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Photos each credential type needs, in the order the form asks for them. */
export const REQUIRED_DOCUMENTS: Record<
  CredentialType,
  readonly DocumentKind[]
> = {
  pharmacist: ["national_id_front", "national_id_back", "syndicate_card"],
  student: ["national_id_front", "national_id_back", "student_card"],
};

export const DECISIONS = ["verified", "rejected"] as const;
export type Decision = (typeof DECISIONS)[number];

/** Reason codes per decision. Rejection reasons are shown to the user, localized. */
export const APPROVE_REASONS = ["documents_match"] as const;
export const REJECT_REASONS = [
  "document_unreadable",
  "document_missing_or_wrong",
  "details_mismatch",
  "credential_not_confirmed",
  "card_expired",
  "other",
] as const;
export type ApproveReason = (typeof APPROVE_REASONS)[number];
export type RejectReason = (typeof REJECT_REASONS)[number];
export type ReasonCode = ApproveReason | RejectReason;
export const REASON_CODES = [...APPROVE_REASONS, ...REJECT_REASONS] as const;

export const REASONS_FOR: Record<Decision, readonly ReasonCode[]> = {
  verified: APPROVE_REASONS,
  rejected: REJECT_REASONS,
};

/**
 * `view`: a reviewer was issued a signed URL for a document.
 * `reveal_national_id`: a reviewer was shown the decrypted national ID.
 */
export const ACCESS_ACTIONS = ["view", "reveal_national_id"] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

/** Languages emails about a submission are sent in (the page's locale at submit). */
export const EMAIL_LOCALES = ["ar", "en"] as const;
export type EmailLocale = (typeof EMAIL_LOCALES)[number];

export const NOTIFICATION_KINDS = ["received", "verified", "rejected"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * Version of the consent text the user accepted. The wording is a placeholder
 * until counsel answers question 5 (docs/privacy/data-protection-status.md);
 * bump this when the approved wording replaces it.
 */
export const CONSENT_VERSION = "draft-pending-counsel";

export const LIMITS = {
  syndicateNumber: { min: 1, max: 12 },
  university: { min: 2, max: 120 },
  /**
   * Legal name in Arabic, as on the national ID, after normalization (code
   * points). Egyptian IDs carry a four-part name; three words is the minimum
   * accepted. `rawMax` bounds the input before normalization.
   */
  legalNameAr: { min: 5, max: 120, minWords: 3, rawMax: 400 },
  note: { max: 500 },
  /** Card expiry: no later than this many years ahead. */
  cardExpiryMaxYears: 10,
  /** Age at submission, from the birth date in the national ID. */
  age: { min: 17, max: 90 },
  queuePageSize: 20,
} as const;

/**
 * The stored shape of a legal name (validation.ts normalizes to it): words of
 * Arabic letters (ء-غ, ف-ي, which include every hamza and alef form, taa
 * marbuta and alef maqsura, plus alef wasla ٱ), optionally joined inside a word
 * by a hyphen or an apostrophe, separated by single spaces, at least
 * `minWords` words. No diacritics, tatweel, digits or Latin letters. Written
 * with `\u` escapes so the same source works as a JavaScript RegExp (`u` flag)
 * and as a PostgreSQL regular expression (the database CHECK).
 */
const ARABIC_LETTER = "[\\u0621-\\u063A\\u0641-\\u064A\\u0671]";
const NAME_WORD = `${ARABIC_LETTER}+(?:[-']${ARABIC_LETTER}+)*`;
export const LEGAL_NAME_AR_PATTERN = `^${NAME_WORD}(?: ${NAME_WORD}){${LIMITS.legalNameAr.minWords - 1},}$`;
/** One allowed character of a normalized legal name (letters, space, hyphen, apostrophe). */
export const LEGAL_NAME_AR_CHARACTER =
  "[\\u0621-\\u063A\\u0641-\\u064A\\u0671 '-]";

/** All dates are computed in Egypt's zone (DST since 2023, never a fixed offset). */
export const TIME_ZONE = "Africa/Cairo";

function includes<T extends string>(
  list: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (list as readonly string[]).includes(value)
  );
}

export const isCredentialType = (v: unknown): v is CredentialType =>
  includes(CREDENTIAL_TYPES, v);
export const isSubmissionStatus = (v: unknown): v is SubmissionStatus =>
  includes(SUBMISSION_STATUSES, v);
export const isDocumentKind = (v: unknown): v is DocumentKind =>
  includes(DOCUMENT_KINDS, v);
export const isDecision = (v: unknown): v is Decision => includes(DECISIONS, v);
export const isReasonCode = (v: unknown): v is ReasonCode =>
  includes(REASON_CODES, v);
export const isRejectReason = (v: unknown): v is RejectReason =>
  includes(REJECT_REASONS, v);
export const isEmailLocale = (v: unknown): v is EmailLocale =>
  includes(EMAIL_LOCALES, v);

/** True when `reason` is allowed for `decision` (approve and reject lists differ). */
export function reasonFits(decision: Decision, reason: unknown): boolean {
  return includes(REASONS_FOR[decision], reason);
}
