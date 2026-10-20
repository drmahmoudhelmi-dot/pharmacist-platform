// Allowed values and limits for profiles (ADR-003). Kept free of imports so
// the schema, the policy, validation and client components can all share them.

export const CAREER_STAGES = ["student", "graduate", "pharmacist"] as const;
export type CareerStage = (typeof CAREER_STAGES)[number];

export const SPECIALTIES = [
  "community",
  "hospital",
  "clinical",
  "industry",
  "medical_rep",
  "regulatory",
  "other",
] as const;
export type Specialty = (typeof SPECIALTIES)[number];

export const VISIBILITIES = ["members", "hidden"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const LIMITS = {
  displayName: { min: 2, max: 80 },
  headline: { max: 120 },
  bio: { max: 1000 },
  yearsExperience: { min: 0, max: 60 },
  university: { max: 120 },
  /** Earliest graduation and work-start year accepted. */
  earliestYear: 1960,
  /** Students may enter an expected graduation year this far ahead. */
  graduationYearsAhead: 7,
  experienceTitle: { max: 120 },
  employerName: { max: 120 },
  experiencePerUser: 30,
} as const;

function includes<T extends string>(
  list: readonly T[],
  value: unknown,
): value is T {
  return (
    typeof value === "string" && (list as readonly string[]).includes(value)
  );
}

export const isCareerStage = (v: unknown): v is CareerStage =>
  includes(CAREER_STAGES, v);
export const isSpecialty = (v: unknown): v is Specialty =>
  includes(SPECIALTIES, v);
export const isVisibility = (v: unknown): v is Visibility =>
  includes(VISIBILITIES, v);
