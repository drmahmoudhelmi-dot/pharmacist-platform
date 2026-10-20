import { z } from "zod";
import { toWesternDigits } from "@/shared/text/digits";
import { normalizeName } from "@/shared/text/name";
import { normalizeEgyptianMobile } from "@/shared/text/phone";
import {
  CAREER_STAGES,
  type CareerStage,
  LIMITS,
  SPECIALTIES,
  type Specialty,
  VISIBILITIES,
  type Visibility,
} from "./constants";

// Validation for profile forms. Runs in the browser for fast feedback and,
// authoritatively, in the services on the server. Errors are stable codes that
// the UI maps to localized messages ("ProfileErrors" in messages/*.json).

export type FieldErrorCode =
  | "required"
  | "tooShort"
  | "tooLong"
  | "invalidNumber"
  | "outOfRange"
  | "invalidChoice"
  | "invalidPhone"
  | "invalidMonth"
  | "inFuture"
  | "endBeforeStart";

export type FieldErrors<K extends string> = Partial<Record<K, FieldErrorCode>>;

export type Parsed<T, K extends string> =
  { ok: true; data: T } | { ok: false; fieldErrors: FieldErrors<K> };

/** Raw form input: strings from FormData, string arrays for multi-selects. */
export type RawForm = Record<string, unknown>;

/** Form data as a plain object; repeated keys (checkbox groups) become arrays. */
export function formDataToRaw(form: FormData, multi: readonly string[] = []) {
  const raw: RawForm = {};
  for (const key of new Set(form.keys())) {
    if (key.startsWith("$ACTION")) continue;
    const values = form
      .getAll(key)
      .map((v) => (typeof v === "string" ? v : ""));
    raw[key] = multi.includes(key) ? values : values[0];
  }
  for (const key of multi) raw[key] ??= [];
  return raw;
}

// C0 controls except tab and line breaks, plus DEL.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Length in characters (code points), matching PostgreSQL's char_length. */
export const charLength = (value: string) => [...value].length;

/** Single-line text: tatweel removed, whitespace collapsed, trimmed. */
function line(value: unknown): string {
  return typeof value === "string"
    ? normalizeName(value.replace(CONTROL, ""))
    : "";
}

/** Multi-line text: line endings unified, at most one blank line, trimmed. */
function paragraph(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL, "")
    .split("\n")
    .map((l) => l.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function digits(value: unknown): string {
  return typeof value === "string" ? toWesternDigits(value).trim() : "";
}

function requiredLine(min: number, max: number) {
  return z.preprocess(
    line,
    z
      .string()
      .refine((v) => v.length > 0, { error: "required", abort: true })
      .refine((v) => charLength(v) >= min, { error: "tooShort", abort: true })
      .refine((v) => charLength(v) <= max, { error: "tooLong" }),
  );
}

/** Optional text: empty becomes null. */
function optionalText(max: number, normalize: (v: unknown) => string = line) {
  return z.preprocess(
    normalize,
    z
      .string()
      .refine((v) => charLength(v) <= max, { error: "tooLong" })
      .transform((v) => (v === "" ? null : v)),
  );
}

/** An integer typed with Western, Eastern Arabic or Persian digits. */
function integer(min: number, max: number) {
  return z
    .string()
    .refine((v) => /^\d{1,6}$/.test(v), { error: "invalidNumber", abort: true })
    .transform(Number)
    .refine((n) => n >= min && n <= max, { error: "outOfRange" });
}

function requiredInteger(min: number, max: number) {
  return z.preprocess(
    digits,
    z
      .string()
      .refine((v) => v !== "", { error: "required", abort: true })
      .pipe(integer(min, max)),
  );
}

function optionalInteger(min: number, max: number) {
  return z.preprocess(
    digits,
    z.string().transform((v, ctx): number | null => {
      if (v === "") return null;
      const code = !/^\d{1,6}$/.test(v)
        ? "invalidNumber"
        : Number(v) < min || Number(v) > max
          ? "outOfRange"
          : null;
      if (code) {
        ctx.addIssue({ code: "custom", message: code });
        return z.NEVER;
      }
      return Number(v);
    }),
  );
}

function choice<T extends string>(values: readonly T[]) {
  return z.preprocess(
    (v) => (typeof v === "string" ? v.trim() : ""),
    z
      .string()
      .refine((v) => v !== "", { error: "required", abort: true })
      .refine((v): v is T => (values as readonly string[]).includes(v), {
        error: "invalidChoice",
      })
      .transform((v) => v as T),
  );
}

const checkbox = z.preprocess(
  (v) => v === "on" || v === "true" || v === true,
  z.boolean(),
);

function collect<T, K extends string>(
  result: z.ZodSafeParseResult<T>,
): Parsed<T, K> {
  if (result.success) return { ok: true, data: result.data };
  const fieldErrors: FieldErrors<K> = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0];
    if (typeof key !== "string" || fieldErrors[key as K]) continue;
    fieldErrors[key as K] = toCode(issue.message);
  }
  return { ok: false, fieldErrors };
}

const CODES: readonly FieldErrorCode[] = [
  "required",
  "tooShort",
  "tooLong",
  "invalidNumber",
  "outOfRange",
  "invalidChoice",
  "invalidPhone",
  "invalidMonth",
  "inFuture",
  "endBeforeStart",
];

function toCode(message: string): FieldErrorCode {
  return (CODES as readonly string[]).includes(message)
    ? (message as FieldErrorCode)
    : // Zod's own messages (e.g. wrong type) are never shown.
      "invalidChoice";
}

// ---------------------------------------------------------------------------
// Profile

export type ProfileInput = {
  displayName: string;
  headline: string | null;
  bio: string | null;
  careerStage: CareerStage;
  yearsExperience: number;
  governorateId: number | null;
  specialties: Specialty[];
  openToWork: boolean;
  visibility: Visibility;
};

export type ProfileField = keyof ProfileInput;

const specialties = z.preprocess(
  (v) => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []),
  z
    .array(z.string())
    .refine(
      (list) =>
        list.every((s) => (SPECIALTIES as readonly string[]).includes(s)),
      { error: "invalidChoice", abort: true },
    )
    // Canonical order, no duplicates.
    .transform((list) => SPECIALTIES.filter((s) => list.includes(s))),
);

const profileSchema = z.object({
  displayName: requiredLine(LIMITS.displayName.min, LIMITS.displayName.max),
  headline: optionalText(LIMITS.headline.max),
  bio: optionalText(LIMITS.bio.max, paragraph),
  careerStage: choice(CAREER_STAGES),
  yearsExperience: requiredInteger(
    LIMITS.yearsExperience.min,
    LIMITS.yearsExperience.max,
  ),
  // Existence is checked by the database foreign key (see the service).
  governorateId: optionalInteger(1, 32767),
  specialties,
  openToWork: checkbox,
  visibility: choice(VISIBILITIES),
});

export function parseProfile(raw: RawForm): Parsed<ProfileInput, ProfileField> {
  return collect(profileSchema.safeParse(raw));
}

// ---------------------------------------------------------------------------
// Professional details (private)

export type ProfessionalDetailsInput = {
  phoneE164: string | null;
  university: string | null;
  graduationYear: number | null;
};

export type ProfessionalDetailsField =
  "phone" | "university" | "graduationYear";

/** Year and month (1-12) in Africa/Cairo. */
export function cairoYearMonth(now: Date): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "numeric",
  }).formatToParts(now);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month") };
}

const phone = z.preprocess(
  (v) => (typeof v === "string" ? v : ""),
  z.string().transform((v, ctx) => {
    if (v.trim() === "") return null;
    const result = normalizeEgyptianMobile(v);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: "invalidPhone" });
      return z.NEVER;
    }
    return result.e164;
  }),
);

export function parseProfessionalDetails(
  raw: RawForm,
  now: Date = new Date(),
): Parsed<ProfessionalDetailsInput, ProfessionalDetailsField> {
  const { year } = cairoYearMonth(now);
  const schema = z.object({
    phone,
    university: optionalText(LIMITS.university.max),
    graduationYear: optionalInteger(
      LIMITS.earliestYear,
      year + LIMITS.graduationYearsAhead,
    ),
  });
  const result = collect<z.infer<typeof schema>, ProfessionalDetailsField>(
    schema.safeParse(raw),
  );
  if (!result.ok) return result;
  return {
    ok: true,
    data: {
      phoneE164: result.data.phone,
      university: result.data.university,
      graduationYear: result.data.graduationYear,
    },
  };
}

// ---------------------------------------------------------------------------
// Experience

export type ExperienceInput = {
  title: string;
  employerName: string;
  /** First day of the month, `YYYY-MM-01`. */
  startMonth: string;
  /** `YYYY-MM-01`, or null for a current position. */
  endMonth: string | null;
};

export type ExperienceField =
  | "title"
  | "employerName"
  | "startMonth"
  | "startYear"
  | "endMonth"
  | "endYear";

const monthNumber = z.preprocess(
  digits,
  z
    .string()
    .refine((v) => v !== "", { error: "required", abort: true })
    .refine((v) => /^\d{1,2}$/.test(v), { error: "invalidMonth", abort: true })
    .transform(Number)
    .refine((n) => n >= 1 && n <= 12, { error: "invalidMonth" }),
);

export const toMonthDate = (year: number, month: number) =>
  `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;

export function parseExperience(
  raw: RawForm,
  now: Date = new Date(),
): Parsed<ExperienceInput, ExperienceField> {
  const current = cairoYearMonth(now);
  const year = requiredInteger(LIMITS.earliestYear, current.year);
  const isCurrent = checkbox.parse(raw.current);
  const base = z.object({
    title: requiredLine(1, LIMITS.experienceTitle.max),
    employerName: requiredLine(1, LIMITS.employerName.max),
    startMonth: monthNumber,
    startYear: year,
  });
  const schema = isCurrent
    ? base
    : base.extend({ endMonth: monthNumber, endYear: year });
  const result = collect<
    {
      startYear: number;
      startMonth: number;
      endYear?: number;
      endMonth?: number;
    } & {
      title: string;
      employerName: string;
    },
    ExperienceField
  >(schema.safeParse(raw));
  if (!result.ok) return result;
  const d = result.data;
  const fieldErrors: FieldErrors<ExperienceField> = {};
  const startKey = d.startYear * 12 + d.startMonth;
  const nowKey = current.year * 12 + current.month;
  if (startKey > nowKey) fieldErrors.startMonth = "inFuture";
  let endMonth: string | null = null;
  if (!isCurrent && d.endYear !== undefined && d.endMonth !== undefined) {
    const endKey = d.endYear * 12 + d.endMonth;
    if (endKey > nowKey) fieldErrors.endMonth = "inFuture";
    else if (endKey < startKey) fieldErrors.endMonth = "endBeforeStart";
    endMonth = toMonthDate(d.endYear, d.endMonth);
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return {
    ok: true,
    data: {
      title: d.title,
      employerName: d.employerName,
      startMonth: toMonthDate(d.startYear, d.startMonth),
      endMonth,
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids from URLs and forms are checked before they reach a query. */
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);
