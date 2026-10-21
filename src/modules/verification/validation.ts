import { toWesternDigits } from "@/shared/text/digits";
import { normalizeName } from "@/shared/text/name";
import {
  type CredentialType,
  type Decision,
  type DocumentKind,
  isCredentialType,
  isDecision,
  LIMITS,
  type ReasonCode,
  REQUIRED_DOCUMENTS,
  reasonFits,
} from "./constants";
import { type LegalNameError, parseLegalNameAr } from "./legal-name";
import {
  cairoDate,
  type NationalIdError,
  parseNationalId,
  type ParsedNationalId,
} from "./national-id";

// Validation of the submission and decision forms. Runs in the browser for
// fast feedback and, authoritatively, in the services. Errors are stable codes
// mapped to localized messages ("VerificationErrors" in messages/*.json).

export type SubmissionField =
  | "credentialType"
  | "legalNameAr"
  | "nationalId"
  | "syndicateNumber"
  | "university"
  | "cardExpiresOn"
  | "consent"
  | DocumentKind;

export type FieldErrorCode =
  | NationalIdError
  | LegalNameError
  | "required"
  | "invalidChoice"
  | "invalidNumber"
  | "tooShort"
  | "tooLong"
  | "invalidDate"
  | "inPast"
  | "tooFarAhead"
  | "consentRequired"
  // Document photos, checked by the service against the uploads module.
  | "documentNotFound"
  | "documentProcessing"
  | "documentRejected"
  | "documentInUse";

export type FieldErrors<K extends string> = Partial<Record<K, FieldErrorCode>>;

export type RawForm = Record<string, unknown>;

export type SubmissionInput = {
  credentialType: CredentialType;
  /** Normalized (see legal-name.ts), exactly what is stored. */
  legalNameAr: string;
  nationalId: ParsedNationalId;
  syndicateNumber: string | null;
  university: string | null;
  /** `YYYY-MM-DD` or null. */
  cardExpiresOn: string | null;
  /** Upload id per required document kind. */
  documents: Partial<Record<DocumentKind, string>>;
};

export type Parsed<T, K extends string> =
  { ok: true; data: T } | { ok: false; fieldErrors: FieldErrors<K> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001F\u007F]/g;

const text = (v: unknown) =>
  typeof v === "string" ? normalizeName(v.replace(CONTROL, "")) : "";
const digits = (v: unknown) =>
  typeof v === "string" ? toWesternDigits(v).replace(/[\s-]/g, "") : "";
const charLength = (v: string) => [...v].length;

function parseExpiry(
  raw: unknown,
  now: Date,
): { ok: true; value: string | null } | { ok: false; error: FieldErrorCode } {
  const value = typeof raw === "string" ? toWesternDigits(raw).trim() : "";
  if (value === "") return { ok: true, value: null };
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return { ok: false, error: "invalidDate" };
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const real = new Date(Date.UTC(y, m - 1, d));
  if (
    real.getUTCFullYear() !== y ||
    real.getUTCMonth() !== m - 1 ||
    real.getUTCDate() !== d
  )
    return { ok: false, error: "invalidDate" };
  const today = cairoDate(now);
  const key = (a: { y: number; m: number; d: number }) =>
    a.y * 10_000 + a.m * 100 + a.d;
  if (key({ y, m, d }) < key(today)) return { ok: false, error: "inPast" };
  if (
    key({ y, m, d }) > key({ ...today, y: today.y + LIMITS.cardExpiryMaxYears })
  )
    return { ok: false, error: "tooFarAhead" };
  return { ok: true, value };
}

/**
 * Parses the submission form. `documents` maps each required kind to an
 * upload id; the service checks ownership and status, this only checks shape.
 */
export function parseSubmission(
  raw: RawForm,
  now: Date,
): Parsed<SubmissionInput, SubmissionField> {
  const errors: FieldErrors<SubmissionField> = {};
  const type = raw.credentialType;
  if (!isCredentialType(type))
    errors.credentialType = type ? "invalidChoice" : "required";

  const legalName = parseLegalNameAr(raw.legalNameAr);
  if (!legalName.ok) errors.legalNameAr = legalName.error;

  const id = parseNationalId(raw.nationalId, now);
  if (!id.ok) errors.nationalId = id.error;

  let syndicateNumber: string | null = null;
  let university: string | null = null;
  if (type === "pharmacist") {
    const n = digits(raw.syndicateNumber);
    if (n === "") errors.syndicateNumber = "required";
    else if (!/^\d+$/.test(n)) errors.syndicateNumber = "invalidNumber";
    else if (n.length > LIMITS.syndicateNumber.max)
      errors.syndicateNumber = "tooLong";
    else syndicateNumber = n;
  } else if (type === "student") {
    const u = text(raw.university);
    if (u === "") errors.university = "required";
    else if (charLength(u) < LIMITS.university.min)
      errors.university = "tooShort";
    else if (charLength(u) > LIMITS.university.max)
      errors.university = "tooLong";
    else university = u;
  }

  const expiry = parseExpiry(raw.cardExpiresOn, now);
  if (!expiry.ok) errors.cardExpiresOn = expiry.error;

  if (raw.consent !== "on" && raw.consent !== "true" && raw.consent !== true)
    errors.consent = "consentRequired";

  const documents: Partial<Record<DocumentKind, string>> = {};
  if (isCredentialType(type)) {
    for (const kind of REQUIRED_DOCUMENTS[type]) {
      const value = raw[kind];
      if (typeof value === "string" && UUID.test(value))
        documents[kind] = value.toLowerCase();
      else errors[kind] = "required";
    }
  }

  if (
    Object.keys(errors).length > 0 ||
    !legalName.ok ||
    !id.ok ||
    !isCredentialType(type) ||
    !expiry.ok
  )
    return { ok: false, fieldErrors: errors };
  return {
    ok: true,
    data: {
      credentialType: type,
      legalNameAr: legalName.value,
      nationalId: id.data,
      syndicateNumber,
      university,
      cardExpiresOn: expiry.value,
      documents,
    },
  };
}

export type DecisionField = "decision" | "reasonCode" | "note";

export type DecisionInput = {
  decision: Decision;
  reasonCode: ReasonCode;
  note: string | null;
};

/** Parses a reviewer's decision: a decision, a reason that fits it, an optional note. */
export function parseDecision(
  raw: RawForm,
): Parsed<DecisionInput, DecisionField> {
  const errors: FieldErrors<DecisionField> = {};
  const decision = raw.decision;
  if (!isDecision(decision))
    errors.decision = decision ? "invalidChoice" : "required";
  const reason = raw.reasonCode;
  if (!reason) errors.reasonCode = "required";
  else if (!isDecision(decision) || !reasonFits(decision, reason))
    errors.reasonCode = "invalidChoice";
  const note =
    typeof raw.note === "string"
      ? raw.note
          .replace(/\r\n?/g, "\n")
          .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "")
          .trim()
      : "";
  if (charLength(note) > LIMITS.note.max) errors.note = "tooLong";
  if (Object.keys(errors).length > 0 || !isDecision(decision))
    return { ok: false, fieldErrors: errors };
  return {
    ok: true,
    data: {
      decision,
      reasonCode: reason as ReasonCode,
      note: note === "" ? null : note,
    },
  };
}

/** Form data as a plain object (no repeated keys in these forms). */
export function formDataToRaw(form: FormData): RawForm {
  const raw: RawForm = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith("$ACTION")) continue;
    raw[key] = typeof value === "string" ? value : "";
  }
  return raw;
}
