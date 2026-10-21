import { normalizeName } from "@/shared/text/name";
import {
  LEGAL_NAME_AR_CHARACTER,
  LEGAL_NAME_AR_PATTERN,
  LIMITS,
} from "./constants";

// The user's legal name in Arabic, exactly as written on the national ID card
// (ADR-004, 4c). Reviewers compare it with the card photo; it is never shown
// on profiles or in emails. Pure functions, shared by the browser form and the
// service.

export type LegalNameError =
  | "required"
  | "tooShort"
  | "tooLong"
  | "nameNotArabic"
  | "nameFormat"
  | "nameTooFewWords";

/**
 * Arabic diacritics (harakat and Quranic marks): fathatan to sukun and the
 * combining maddah/hamza marks left over after composition (U+064B-U+065F),
 * superscript alef (U+0670), honorific signs (U+0610-U+061A) and small
 * Quranic annotation marks (U+06D6-U+06ED, except the two that are letters).
 */
const DIACRITICS =
  /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/gu;
/** Invisible format characters: bidi marks, ZWJ/ZWNJ, Arabic letter mark, BOM, soft hyphen. */
const FORMAT = /\p{Cf}/gu;
const CONTROL = /\p{Cc}/gu;
const HYPHENS = /[\u2010\u2011\u2012\u2013\u2212]/gu;
const APOSTROPHES = /[\u2018\u2019\u02BC]/gu;

const SHAPE = new RegExp(LEGAL_NAME_AR_PATTERN, "u");
const ALLOWED = new RegExp(`^${LEGAL_NAME_AR_CHARACTER}*$`, "u");

/**
 * Normalizes a legal name for validation and storage: Unicode NFKC (composes
 * alef/waw/yaa with a combining hamza or maddah into أ إ آ ؤ ئ and turns
 * Arabic presentation forms, such as the lam-alef ligature, into plain
 * letters), drops diacritics and invisible format characters, unifies hyphen
 * and apostrophe variants, removes spaces around a hyphen, then the shared
 * name normalizer (tatweel removed, whitespace collapsed, trimmed). Persian
 * yeh (ی) and keheh (ک), which look the same and come from Persian keyboard
 * layouts, become Arabic ي and ك. Otherwise letters are never changed: أ
 * stays أ and ة stays ة, as on the card.
 */
export function normalizeLegalNameAr(input: string): string {
  const cleaned = input
    .normalize("NFKC")
    .replace(DIACRITICS, "")
    .replace(FORMAT, "")
    .replace(CONTROL, " ")
    .replace(HYPHENS, "-")
    .replace(APOSTROPHES, "'")
    .replace(/\u06CC/g, "\u064A")
    .replace(/\u06A9/g, "\u0643");
  return normalizeName(cleaned).replace(/ ?- ?/g, "-");
}

const charLength = (v: string) => [...v].length;

/** Validates and normalizes the legal name field; the value is what gets stored. */
export function parseLegalNameAr(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: LegalNameError } {
  if (typeof raw !== "string") return { ok: false, error: "required" };
  if (charLength(raw) > LIMITS.legalNameAr.rawMax)
    return { ok: false, error: "tooLong" };
  const value = normalizeLegalNameAr(raw);
  if (value === "") return { ok: false, error: "required" };
  // Latin letters, digits (Western or Arabic-Indic) and other symbols.
  if (!ALLOWED.test(value)) return { ok: false, error: "nameNotArabic" };
  if (charLength(value) > LIMITS.legalNameAr.max)
    return { ok: false, error: "tooLong" };
  const words = value.split(" ");
  // A hyphen or apostrophe must sit between two letters of a word.
  if (words.some((w) => !/^[^-']+(?:[-'][^-']+)*$/u.test(w)))
    return { ok: false, error: "nameFormat" };
  if (words.length < LIMITS.legalNameAr.minWords)
    return { ok: false, error: "nameTooFewWords" };
  if (charLength(value) < LIMITS.legalNameAr.min)
    return { ok: false, error: "tooShort" };
  // The database CHECK uses the same pattern; this is the final gate.
  if (!SHAPE.test(value)) return { ok: false, error: "nameFormat" };
  return { ok: true, value };
}
