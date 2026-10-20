import { toWesternDigits } from "@/shared/text/digits";

// Client-side checks are a convenience for fast feedback; the server
// (Better Auth with the limits in auth-config.ts) is authoritative.
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function checkEmail(value: string): "required" | "invalidEmail" | null {
  const email = value.trim();
  if (!email) return "required";
  return EMAIL_SHAPE.test(email) ? null : "invalidEmail";
}

export function checkPassword(
  value: string,
): "required" | "passwordLength" | null {
  if (!value) return "required";
  // UTF-16 length, matching Better Auth's own check.
  return value.length < PASSWORD_MIN || value.length > PASSWORD_MAX
    ? "passwordLength"
    : null;
}

/** TOTP codes: accept Arabic-Indic digits and stray spaces. */
export function normalizeCode(value: string): string {
  return toWesternDigits(value).replace(/[\s-]/g, "");
}
