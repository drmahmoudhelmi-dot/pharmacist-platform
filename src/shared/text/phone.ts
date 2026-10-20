import { toWesternDigits } from "./digits";

export type PhoneError =
  "empty" | "invalid_characters" | "invalid_length" | "invalid_prefix";

export type PhoneResult =
  { ok: true; e164: string } | { ok: false; error: PhoneError };

// Egyptian mobile operators: 010 Vodafone, 011 Etisalat, 012 Orange, 015 WE.
const VALID_PREFIXES = new Set(["10", "11", "12", "15"]);

/**
 * Normalizes an Egyptian mobile number to E.164 (+201XXXXXXXXX).
 * Accepts 01XXXXXXXXX, +201XXXXXXXXX and 00201XXXXXXXXX, with spaces, dashes,
 * dots or parentheses, and Eastern Arabic or Persian digits.
 */
export function normalizeEgyptianMobile(input: string): PhoneResult {
  const trimmed = toWesternDigits(input).trim();
  if (trimmed === "") return { ok: false, error: "empty" };

  // A "+" is only valid as the first character.
  if (!/^\+?[\d\s\-.()]+$/.test(trimmed))
    return { ok: false, error: "invalid_characters" };

  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  let national: string; // the 10 digits after the leading 0 / country code
  if (hasPlus) {
    if (!digits.startsWith("20")) return { ok: false, error: "invalid_prefix" };
    national = digits.slice(2);
  } else if (digits.startsWith("0020")) {
    national = digits.slice(4);
  } else if (digits.startsWith("0")) {
    national = digits.slice(1);
  } else {
    return { ok: false, error: "invalid_prefix" };
  }

  if (national.length !== 10) return { ok: false, error: "invalid_length" };
  if (!VALID_PREFIXES.has(national.slice(0, 2)))
    return { ok: false, error: "invalid_prefix" };

  return { ok: true, e164: `+20${national}` };
}
