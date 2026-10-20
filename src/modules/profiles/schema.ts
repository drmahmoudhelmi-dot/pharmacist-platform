import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "@/modules/identity/schema";
import { CAREER_STAGES, LIMITS, SPECIALTIES, VISIBILITIES } from "./constants";

// Tables owned by the profiles module (ADR-003). Public profile data and
// private professional details live in separate tables so a public query can
// never select a private column by accident. The foreign keys to `user` are
// the only reference to identity's tables; profiles code never queries them.

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

const timestamps = {
  createdAt: timestamptz("created_at").defaultNow().notNull(),
  updatedAt: timestamptz("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

const sqlList = (values: readonly string[]) =>
  values.map((v) => `'${v}'`).join(", ");

// Reference data: Egypt's 27 governorates, seeded by the migration.
// `code` is the ISO 3166-2:EG subdivision code.
export const governorate = pgTable(
  "governorate",
  {
    id: smallint("id").primaryKey(),
    code: text("code").notNull().unique(),
    nameAr: text("name_ar").notNull().unique(),
    nameEn: text("name_en").notNull().unique(),
  },
  (table) => [
    check("governorate_code_check", sql`${table.code} ~ '^EG-[A-Z]{1,3}$'`),
  ],
);

export const profile = pgTable(
  "profile",
  {
    // Public identifier used in URLs; deliberately not the auth user id.
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    headline: text("headline"),
    bio: text("bio"),
    careerStage: text("career_stage", { enum: CAREER_STAGES }).notNull(),
    yearsExperience: smallint("years_experience").default(0).notNull(),
    governorateId: smallint("governorate_id").references(() => governorate.id, {
      onDelete: "restrict",
    }),
    specialties: text("specialties", { enum: SPECIALTIES })
      .array()
      .default(sql`'{}'::text[]`)
      .notNull(),
    openToWork: boolean("open_to_work").default(false).notNull(),
    visibility: text("visibility", { enum: VISIBILITIES })
      .default("members")
      .notNull(),
    ...timestamps,
  },
  (table) => [
    // Employer search in step 6 filters on these; governorate_id leads so the
    // index also serves the foreign key.
    index("profile_search_idx").on(
      table.governorateId,
      table.careerStage,
      table.openToWork,
    ),
    check(
      "profile_career_stage_check",
      sql.raw(`career_stage in (${sqlList(CAREER_STAGES)})`),
    ),
    check(
      "profile_visibility_check",
      sql.raw(`visibility in (${sqlList(VISIBILITIES)})`),
    ),
    check(
      "profile_years_experience_check",
      sql.raw(
        `years_experience between ${LIMITS.yearsExperience.min} and ${LIMITS.yearsExperience.max}`,
      ),
    ),
    // Every element must be in the allowed list; NULL elements fail `<@`.
    check(
      "profile_specialties_check",
      sql.raw(
        `specialties <@ array[${sqlList(SPECIALTIES)}]::text[] and cardinality(specialties) <= ${SPECIALTIES.length}`,
      ),
    ),
    check(
      "profile_display_name_check",
      sql.raw(
        `char_length(display_name) between ${LIMITS.displayName.min} and ${LIMITS.displayName.max}`,
      ),
    ),
    check(
      "profile_headline_check",
      sql.raw(`char_length(headline) <= ${LIMITS.headline.max}`),
    ),
    check(
      "profile_bio_check",
      sql.raw(`char_length(bio) <= ${LIMITS.bio.max}`),
    ),
  ],
);

// Private: only the owner reads these in step 3 (ADR-003).
export const professionalDetails = pgTable(
  "professional_details",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    // E.164 Egyptian mobile (+2010…, +2011…, +2012…, +2015…).
    phoneE164: text("phone_e164"),
    university: text("university"),
    graduationYear: smallint("graduation_year"),
    ...timestamps,
  },
  () => [
    check(
      "professional_details_phone_check",
      sql.raw(`phone_e164 ~ '^\\+201[0125][0-9]{8}$'`),
    ),
    check(
      "professional_details_university_check",
      sql.raw(`char_length(university) <= ${LIMITS.university.max}`),
    ),
    // The service also caps it at the current year plus a few for students.
    check(
      "professional_details_graduation_year_check",
      sql.raw(`graduation_year between ${LIMITS.earliestYear} and 2100`),
    ),
  ],
);

// Months are stored as the first day of the month. end_month NULL = current.
export const experience = pgTable(
  "experience",
  {
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    employerName: text("employer_name").notNull(),
    startMonth: date("start_month", { mode: "string" }).notNull(),
    endMonth: date("end_month", { mode: "string" }),
    ...timestamps,
  },
  (table) => [
    index("experience_user_id_idx").on(table.userId),
    check(
      "experience_months_check",
      sql.raw(
        `extract(day from start_month) = 1 and (end_month is null or extract(day from end_month) = 1) and start_month >= date '${LIMITS.earliestYear}-01-01'`,
      ),
    ),
    check(
      "experience_end_after_start_check",
      sql.raw(`end_month is null or end_month >= start_month`),
    ),
    check(
      "experience_title_check",
      sql.raw(`char_length(title) between 1 and ${LIMITS.experienceTitle.max}`),
    ),
    check(
      "experience_employer_name_check",
      sql.raw(
        `char_length(employer_name) between 1 and ${LIMITS.employerName.max}`,
      ),
    ),
  ],
);
