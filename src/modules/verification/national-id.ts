import { toWesternDigits } from "@/shared/text/digits";
import { LIMITS, TIME_ZONE } from "./constants";

// Egyptian national ID number checks (ADR-004, 4b). Pure functions with no
// Node-only imports, so the form gives the same answer in the browser that the
// server enforces.
//
// Structure (14 digits): C YYMMDD GG SSSS K
//   C     century of birth: 2 = 1900s, 3 = 2000s
//   YYMMDD birth date
//   GG    governorate of birth registration (list below), 88 = born abroad
//   SSSS  serial (its last digit is reported to be odd for men and even for
//         women; not used here: the platform has no reason to infer sex)
//   K     check digit. NOT validated: no official algorithm is published, and
//         rejecting a real ID on a guessed formula would lock people out.
//
// Governorate codes: 27 governorates plus 88. Cross-checked against the
// Wikipedia article "Egyptian National Identity Card" (provincial codes table)
// and two independent ID-parsing references, which agree; no Civil Status
// Organization publication was found online. Codes 05-10, 20 and 30 are
// unassigned. Former governorates (Helwan, 6th of October, 2008-2011) are
// not known to have had their own codes.

export const GOVERNORATE_CODES = [
  "01", // Cairo
  "02", // Alexandria
  "03", // Port Said
  "04", // Suez
  "11", // Damietta
  "12", // Dakahlia
  "13", // Sharqia
  "14", // Qalyubia
  "15", // Kafr El Sheikh
  "16", // Gharbia
  "17", // Monufia
  "18", // Beheira
  "19", // Ismailia
  "21", // Giza
  "22", // Beni Suef
  "23", // Fayoum
  "24", // Minya
  "25", // Assiut
  "26", // Sohag
  "27", // Qena
  "28", // Aswan
  "29", // Luxor
  "31", // Red Sea
  "32", // New Valley
  "33", // Matrouh
  "34", // North Sinai
  "35", // South Sinai
  "88", // Born outside Egypt
] as const;

export type NationalIdError =
  | "required"
  | "invalidFormat"
  | "invalidCentury"
  | "invalidBirthDate"
  | "ageOutOfRange"
  | "invalidGovernorate";

export type ParsedNationalId = {
  /** 14 Western digits. */
  value: string;
  /** `YYYY-MM-DD` */
  birthDate: string;
  governorateCode: (typeof GOVERNORATE_CODES)[number];
};

export type NationalIdResult =
  { ok: true; data: ParsedNationalId } | { ok: false; error: NationalIdError };

/**
 * Western, Eastern Arabic and Persian digits become Western; spaces, dashes
 * and bidi marks people paste in are dropped. Anything else is kept so it
 * fails the format check rather than being silently removed.
 */
export function normalizeNationalId(input: unknown): string {
  if (typeof input !== "string") return "";
  return toWesternDigits(input).replace(/[\s ‎‏‪-‮⁦-⁩-]/g, "");
}

/** Today's calendar date in Cairo as numbers. */
export function cairoDate(now: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** Today's date in Cairo as `YYYY-MM-DD`. */
export function cairoToday(now: Date): string {
  const { y, m, d } = cairoDate(now);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= days;
}

/** Whole years between a birth date and a calendar date. */
export function ageOn(
  birth: { y: number; m: number; d: number },
  on: { y: number; m: number; d: number },
): number {
  let age = on.y - birth.y;
  if (on.m < birth.m || (on.m === birth.m && on.d < birth.d)) age -= 1;
  return age;
}

/** Validates a national ID number as of `now` (age is counted in Cairo). */
export function parseNationalId(input: unknown, now: Date): NationalIdResult {
  const value = normalizeNationalId(input);
  if (value === "") return { ok: false, error: "required" };
  if (!/^\d{14}$/.test(value)) return { ok: false, error: "invalidFormat" };

  const century = value[0];
  if (century !== "2" && century !== "3")
    return { ok: false, error: "invalidCentury" };
  const y = (century === "2" ? 1900 : 2000) + Number(value.slice(1, 3));
  const m = Number(value.slice(3, 5));
  const d = Number(value.slice(5, 7));
  if (!isRealDate(y, m, d)) return { ok: false, error: "invalidBirthDate" };

  const today = cairoDate(now);
  const birth = { y, m, d };
  const bornLater =
    y > today.y ||
    (y === today.y && (m > today.m || (m === today.m && d > today.d)));
  if (bornLater) return { ok: false, error: "invalidBirthDate" };
  const age = ageOn(birth, today);
  if (age < LIMITS.age.min || age > LIMITS.age.max)
    return { ok: false, error: "ageOutOfRange" };

  const governorate = value.slice(7, 9);
  const code = GOVERNORATE_CODES.find((c) => c === governorate);
  if (!code) return { ok: false, error: "invalidGovernorate" };

  return {
    ok: true,
    data: {
      value,
      birthDate: `${y}-${value.slice(3, 5)}-${value.slice(5, 7)}`,
      governorateCode: code,
    },
  };
}

/**
 * Masked for display: first digit, ten asterisks, last three digits
 * (`2**********345`). The only form shown outside a reviewer's explicit reveal.
 */
export function maskNationalId(value: string): string {
  if (!/^\d{14}$/.test(value)) throw new Error("not a national ID");
  return `${value[0]}${"*".repeat(10)}${value.slice(11)}`;
}
