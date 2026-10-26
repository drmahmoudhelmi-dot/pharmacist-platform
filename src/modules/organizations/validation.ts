import { toWesternDigits } from "@/shared/text/digits";
import { normalizeName } from "@/shared/text/name";
import {
  isMemberRole,
  isOrganizationKind,
  LIMITS,
  type MemberRole,
  type OrganizationKind,
} from "./constants";

// Validation of the organization and invitation forms. Runs in the browser for
// fast feedback and, authoritatively, in the services. Errors are stable codes
// mapped to localized messages ("OrganizationErrors" in messages/*.json).

export type FieldErrorCode =
  "required" | "tooShort" | "tooLong" | "invalidChoice" | "invalidEmail";

export type FieldErrors<K extends string> = Partial<Record<K, FieldErrorCode>>;

export type Parsed<T, K extends string> =
  { ok: true; data: T } | { ok: false; fieldErrors: FieldErrors<K> };

export type RawForm = Record<string, unknown>;

/** Form data as a plain object (single values; no multi-selects here). */
export function formDataToRaw(form: FormData): RawForm {
  const raw: RawForm = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith("$ACTION") || key in raw) continue;
    raw[key] = typeof value === "string" ? value : "";
  }
  return raw;
}

// C0 controls and DEL.
const CONTROL = /[\u0000-\u001F\u007F]/g;
// Invisible format characters: zero-width spaces and joiners, bidi marks,
// embeddings, overrides and isolates, word joiner, BOM. Organization names are
// shown to other users and in emails, where an override could disguise them.
const FORMAT = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

/** Length in characters (code points), matching PostgreSQL's char_length. */
const charLength = (value: string) => [...value].length;

/** Single-line text: controls dropped, tatweel removed, whitespace collapsed. */
function line(value: unknown): string {
  return typeof value === "string"
    ? normalizeName(value.replace(CONTROL, " ").replace(FORMAT, ""))
    : "";
}

// ---------------------------------------------------------------------------
// Organization details

export type OrganizationInput = {
  kind: OrganizationKind;
  name: string;
  governorateId: number;
  addressLine: string | null;
};

export type OrganizationField = keyof OrganizationInput;

export function parseOrganization(
  raw: RawForm,
): Parsed<OrganizationInput, OrganizationField> {
  const fieldErrors: FieldErrors<OrganizationField> = {};

  const kind = typeof raw.kind === "string" ? raw.kind.trim() : "";
  if (kind === "") fieldErrors.kind = "required";
  else if (!isOrganizationKind(kind)) fieldErrors.kind = "invalidChoice";

  const name = line(raw.name);
  if (name === "") fieldErrors.name = "required";
  else if (charLength(name) < LIMITS.name.min) fieldErrors.name = "tooShort";
  else if (charLength(name) > LIMITS.name.max) fieldErrors.name = "tooLong";

  // Existence is checked against the reference table by the service.
  const governorate =
    typeof raw.governorateId === "string"
      ? toWesternDigits(raw.governorateId).trim()
      : "";
  let governorateId = 0;
  if (governorate === "") fieldErrors.governorateId = "required";
  else if (!/^\d{1,5}$/.test(governorate) || Number(governorate) < 1)
    fieldErrors.governorateId = "invalidChoice";
  else governorateId = Number(governorate);

  const address = line(raw.addressLine);
  if (charLength(address) > LIMITS.addressLine.max)
    fieldErrors.addressLine = "tooLong";

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return {
    ok: true,
    data: {
      kind: kind as OrganizationKind,
      name,
      governorateId,
      addressLine: address === "" ? null : address,
    },
  };
}

// ---------------------------------------------------------------------------
// Invitation

export type InvitationInput = { email: string; role: MemberRole };
export type InvitationField = keyof InvitationInput;

// Same shape check as sign-up's (identity/ui/validation.ts); no IDN rewriting.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lowercased and trimmed, the form identity stores (Better Auth lowercases). */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function parseInvitation(
  raw: RawForm,
): Parsed<InvitationInput, InvitationField> {
  const fieldErrors: FieldErrors<InvitationField> = {};

  const email =
    typeof raw.email === "string"
      ? normalizeEmail(raw.email.replace(CONTROL, ""))
      : "";
  if (email === "") fieldErrors.email = "required";
  else if (email.length > LIMITS.email.max || !EMAIL_SHAPE.test(email))
    fieldErrors.email = "invalidEmail";

  const role = typeof raw.role === "string" ? raw.role.trim() : "";
  if (role === "") fieldErrors.role = "required";
  else if (!isMemberRole(role)) fieldErrors.role = "invalidChoice";

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return { ok: true, data: { email, role: role as MemberRole } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids from URLs and forms are checked before they reach a query. */
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
