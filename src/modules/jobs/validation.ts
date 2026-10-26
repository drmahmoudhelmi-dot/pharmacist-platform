import { cairoToday } from "@/modules/verification/national-id";
import { toWesternDigits } from "@/shared/text/digits";
import { normalizeName } from "@/shared/text/name";
import {
  APPLICATION_LIMITS,
  CAREER_STAGES,
  type CareerStage,
  type EmploymentType,
  isEmploymentType,
  isJobCategory,
  isReasonCode,
  type JobCategory,
  LIMITS,
  type ReasonCode,
  REJECT_REASONS,
} from "./constants";

// Validation of the job and moderation forms. Runs in the browser for fast
// feedback and, authoritatively, in the services. Errors are stable codes
// mapped to localized messages ("JobErrors" in messages/*.json).

export type FieldErrorCode =
  | "required"
  | "tooShort"
  | "tooLong"
  | "invalidChoice"
  | "invalidNumber"
  | "outOfRange"
  | "invalidDate"
  | "inPast"
  | "endBeforeStart"
  | "periodTooLong"
  | "salaryOrder";

export type FieldErrors<K extends string> = Partial<Record<K, FieldErrorCode>>;

export type Parsed<T, K extends string> =
  { ok: true; data: T } | { ok: false; fieldErrors: FieldErrors<K> };

export type RawForm = Record<string, unknown>;

/** Form data as a plain object; `careerStages` (checkboxes) becomes an array. */
export function formDataToRaw(form: FormData): RawForm {
  const raw: RawForm = {};
  for (const key of new Set(form.keys())) {
    if (key.startsWith("$ACTION")) continue;
    const values = form
      .getAll(key)
      .map((v) => (typeof v === "string" ? v : ""));
    raw[key] = key === "careerStages" ? values : values[0];
  }
  raw.careerStages ??= [];
  return raw;
}

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const FORMAT = /[؜​-‏‪-‮⁠-⁩﻿]/g;
const charLength = (value: string) => [...value].length;

function line(value: unknown): string {
  return typeof value === "string"
    ? normalizeName(
        value
          .replace(/[\r\n\t]/g, " ")
          .replace(CONTROL, "")
          .replace(FORMAT, ""),
      )
    : "";
}

/** Multi-line text: line endings unified, at most one blank line, trimmed. */
function paragraph(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL, "")
    .replace(FORMAT, "")
    .split("\n")
    .map((l) => l.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const digits = (value: unknown) =>
  typeof value === "string"
    ? toWesternDigits(value).replace(/[,٬\s]/g, "")
    : "";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const daysBetween = (a: string, b: string) =>
  Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000,
  );

// ---------------------------------------------------------------------------
// Job

export type JobInput = {
  title: string;
  category: JobCategory;
  employmentType: EmploymentType;
  startDate: string | null;
  endDate: string | null;
  governorateId: number;
  area: string | null;
  description: string;
  minYearsExperience: number;
  careerStages: CareerStage[];
  /** Piasters per month. */
  salaryMin: number | null;
  salaryMax: number | null;
};

export type JobField = keyof JobInput;

export function parseJob(
  raw: RawForm,
  now: Date = new Date(),
): Parsed<JobInput, JobField> {
  const e: FieldErrors<JobField> = {};

  const title = line(raw.title);
  if (title === "") e.title = "required";
  else if (charLength(title) < LIMITS.title.min) e.title = "tooShort";
  else if (charLength(title) > LIMITS.title.max) e.title = "tooLong";

  const category = typeof raw.category === "string" ? raw.category.trim() : "";
  if (category === "") e.category = "required";
  else if (!isJobCategory(category)) e.category = "invalidChoice";

  const employmentType =
    typeof raw.employmentType === "string" ? raw.employmentType.trim() : "";
  if (employmentType === "") e.employmentType = "required";
  else if (!isEmploymentType(employmentType))
    e.employmentType = "invalidChoice";

  let startDate: string | null = null;
  let endDate: string | null = null;
  if (employmentType === "temporary") {
    const start = digits(raw.startDate);
    const end = digits(raw.endDate);
    if (start === "") e.startDate = "required";
    else if (!isRealDate(start)) e.startDate = "invalidDate";
    else {
      startDate = start;
      if (start < cairoToday(now)) e.startDate = "inPast";
    }
    if (end === "") e.endDate = "required";
    else if (!isRealDate(end)) e.endDate = "invalidDate";
    else endDate = end;
    if (startDate && endDate) {
      if (endDate < startDate) e.endDate = "endBeforeStart";
      else if (daysBetween(startDate, endDate) > LIMITS.temporaryMaxDays)
        e.endDate = "periodTooLong";
    }
  }

  const governorate = digits(raw.governorateId);
  let governorateId = 0;
  if (governorate === "") e.governorateId = "required";
  else if (!/^\d{1,5}$/.test(governorate) || Number(governorate) < 1)
    e.governorateId = "invalidChoice";
  else governorateId = Number(governorate);

  const area = line(raw.area);
  if (charLength(area) > LIMITS.area.max) e.area = "tooLong";

  const description = paragraph(raw.description);
  if (description === "") e.description = "required";
  else if (charLength(description) < LIMITS.description.min)
    e.description = "tooShort";
  else if (charLength(description) > LIMITS.description.max)
    e.description = "tooLong";

  const yearsRaw = digits(raw.minYearsExperience);
  let minYearsExperience = 0;
  if (yearsRaw !== "") {
    if (!/^\d{1,3}$/.test(yearsRaw)) e.minYearsExperience = "invalidNumber";
    else if (Number(yearsRaw) > LIMITS.minYearsExperience.max)
      e.minYearsExperience = "outOfRange";
    else minYearsExperience = Number(yearsRaw);
  }

  const stagesRaw = Array.isArray(raw.careerStages)
    ? raw.careerStages
    : typeof raw.careerStages === "string" && raw.careerStages
      ? [raw.careerStages]
      : [];
  const careerStages = CAREER_STAGES.filter((s) => stagesRaw.includes(s));
  if (stagesRaw.length === 0) e.careerStages = "required";
  else if (
    !stagesRaw.every((s) => (CAREER_STAGES as readonly unknown[]).includes(s))
  )
    e.careerStages = "invalidChoice";

  const salary = (key: "salaryMin" | "salaryMax"): number | null => {
    const v = digits(raw[key]);
    if (v === "") return null;
    if (!/^\d{1,7}$/.test(v)) {
      e[key] = "invalidNumber";
      return null;
    }
    const pounds = Number(v);
    if (pounds < LIMITS.salaryPounds.min || pounds > LIMITS.salaryPounds.max) {
      e[key] = "outOfRange";
      return null;
    }
    return pounds * 100;
  };
  const salaryMin = salary("salaryMin");
  const salaryMax = salary("salaryMax");
  if (salaryMin !== null && salaryMax !== null && salaryMax < salaryMin)
    e.salaryMax = "salaryOrder";

  if (Object.keys(e).length > 0) return { ok: false, fieldErrors: e };
  return {
    ok: true,
    data: {
      title,
      category: category as JobCategory,
      employmentType: employmentType as EmploymentType,
      startDate,
      endDate,
      governorateId,
      area: area === "" ? null : area,
      description,
      minYearsExperience,
      careerStages,
      salaryMin,
      salaryMax,
    },
  };
}

// ---------------------------------------------------------------------------
// Moderation decision

export type DecisionInput = {
  decision: "approved" | "rejected";
  reasonCode: ReasonCode;
  note: string | null;
};
export type DecisionField = "decision" | "reasonCode" | "note";

export function parseDecision(
  raw: RawForm,
): Parsed<DecisionInput, DecisionField> {
  const e: FieldErrors<DecisionField> = {};
  const decision = raw.decision;
  if (decision !== "approved" && decision !== "rejected")
    e.decision = decision ? "invalidChoice" : "required";
  const reason = typeof raw.reasonCode === "string" ? raw.reasonCode : "";
  const reasonCode: ReasonCode | null =
    decision === "approved"
      ? "meets_guidelines"
      : isReasonCode(reason) &&
          (REJECT_REASONS as readonly string[]).includes(reason)
        ? reason
        : null;
  if (decision === "rejected" && !reasonCode)
    e.reasonCode = reason ? "invalidChoice" : "required";
  const note = paragraph(raw.note);
  if (charLength(note) > LIMITS.note.max) e.note = "tooLong";
  if (Object.keys(e).length > 0 || !reasonCode)
    return { ok: false, fieldErrors: e };
  return {
    ok: true,
    data: {
      decision: decision as "approved" | "rejected",
      reasonCode,
      note: note === "" ? null : note,
    },
  };
}

// ---------------------------------------------------------------------------
// Board search

export type SearchInput = {
  q: string;
  governorateId: number | null;
  category: JobCategory | null;
  employmentType: EmploymentType | null;
  cursor: string | null;
};

/** Lenient: an invalid filter is ignored rather than refused. */
export function parseSearch(
  raw: Record<string, string | undefined>,
): SearchInput {
  const q = line(raw.q).slice(0, LIMITS.searchQuery.max);
  const g = digits(raw.governorate);
  const category = raw.category;
  const type = raw.type;
  return {
    q,
    governorateId: /^\d{1,5}$/.test(g) && Number(g) > 0 ? Number(g) : null,
    category: isJobCategory(category) ? category : null,
    employmentType: isEmploymentType(type) ? type : null,
    cursor:
      typeof raw.cursor === "string" &&
      /^[A-Za-z0-9_-]{1,200}$/.test(raw.cursor)
        ? raw.cursor
        : null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

// ---------------------------------------------------------------------------
// Application form (ADR-007)

export type ApplicationInput = {
  coverNote: string | null;
  sharePhone: boolean;
};
export type ApplicationField = "coverNote";

export function parseApplication(
  raw: RawForm,
): Parsed<ApplicationInput, ApplicationField> {
  const coverNote = paragraph(raw.coverNote);
  if (charLength(coverNote) > APPLICATION_LIMITS.coverNote.max)
    return { ok: false, fieldErrors: { coverNote: "tooLong" } };
  const share = raw.sharePhone;
  return {
    ok: true,
    data: {
      coverNote: coverNote === "" ? null : coverNote,
      sharePhone: share === "on" || share === "true" || share === true,
    },
  };
}
