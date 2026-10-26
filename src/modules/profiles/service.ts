import "server-only";
import { and, count, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { getAccountExport } from "@/modules/identity/export";
import type { Actor } from "@/modules/identity/policy";
import {
  exportOwnOrganizations,
  type OrganizationsExport,
} from "@/modules/organizations/service";
import {
  exportOwnVerification,
  getVerificationBadge,
  type VerificationExportItem,
} from "@/modules/verification/service";
import {
  type CareerStage,
  isCareerStage,
  isSpecialty,
  isVisibility,
  LIMITS,
  type Specialty,
  type Visibility,
} from "./constants";
import { type Governorate, listGovernorates } from "./governorates";
import { can, canViewProfile } from "./policy";
import {
  experience,
  governorate,
  professionalDetails,
  profile,
} from "./schema";
import {
  type ExperienceField,
  type FieldErrors,
  isUuid,
  parseExperience,
  parseProfessionalDetails,
  parseProfile,
  type ProfessionalDetailsField,
  type ProfileField,
  type RawForm,
} from "./validation";

export { type Governorate, listGovernorates } from "./governorates";

// All database access for profiles (ADR-003). Every function takes the Actor
// built from the session; owner ids always come from `actor.userId`, never
// from input. Inputs are validated here, so callers cannot skip it.

type Db = NodePgDatabase;

export type WriteResult<K extends string = never> =
  | { ok: true }
  | {
      ok: false;
      error: "forbidden" | "validation" | "notFound" | "limitReached";
      fieldErrors?: FieldErrors<K>;
    };

const forbidden = { ok: false, error: "forbidden" } as const;
const notFound = { ok: false, error: "notFound" } as const;

export type OwnProfile = {
  id: string;
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

export type OwnProfessionalDetails = {
  phoneE164: string | null;
  university: string | null;
  graduationYear: number | null;
};

export type ExperienceItem = {
  id: string;
  title: string;
  employerName: string;
  /** `YYYY-MM-01` */
  startMonth: string;
  /** `YYYY-MM-01`, or null for a current position. */
  endMonth: string | null;
};

/** What another member sees. Built from public columns only. */
export type ProfileView = {
  id: string;
  displayName: string;
  headline: string | null;
  bio: string | null;
  careerStage: CareerStage;
  yearsExperience: number;
  governorate: Omit<Governorate, "id"> | null;
  specialties: Specialty[];
  openToWork: boolean;
  experience: Omit<ExperienceItem, "id">[];
  isOwner: boolean;
  /** Only meaningful to the owner; others never see a hidden profile. */
  hidden: boolean;
  /**
   * True only when the owner's latest verification submission is verified
   * (verification module). Pending or rejected submissions show nothing.
   */
  verified: boolean;
};

const publicProfileColumns = {
  id: profile.id,
  userId: profile.userId,
  displayName: profile.displayName,
  headline: profile.headline,
  bio: profile.bio,
  careerStage: profile.careerStage,
  yearsExperience: profile.yearsExperience,
  governorateId: profile.governorateId,
  specialties: profile.specialties,
  openToWork: profile.openToWork,
  visibility: profile.visibility,
};

type ProfileRow = Pick<
  typeof profile.$inferSelect,
  keyof typeof publicProfileColumns
>;

function toOwnProfile(row: ProfileRow): OwnProfile {
  return {
    id: row.id,
    displayName: row.displayName,
    headline: row.headline,
    bio: row.bio,
    // The CHECK constraints guarantee these; narrow defensively anyway.
    careerStage: isCareerStage(row.careerStage) ? row.careerStage : "student",
    yearsExperience: row.yearsExperience,
    governorateId: row.governorateId,
    specialties: row.specialties.filter(isSpecialty),
    openToWork: row.openToWork,
    visibility: isVisibility(row.visibility) ? row.visibility : "hidden",
  };
}

// ---------------------------------------------------------------------------
// Own profile

export async function getOwnProfile(
  db: Db,
  actor: Actor,
): Promise<OwnProfile | null> {
  if (!can(actor, "profile.update", { ownerId: actor.userId })) return null;
  const rows = await db
    .select(publicProfileColumns)
    .from(profile)
    .where(eq(profile.userId, actor.userId))
    .limit(1);
  return rows[0] ? toOwnProfile(rows[0]) : null;
}

/** Creates the profile on first save, updates it afterwards. */
export async function upsertOwnProfile(
  db: Db,
  actor: Actor,
  raw: RawForm,
): Promise<WriteResult<ProfileField>> {
  if (!can(actor, "profile.update", { ownerId: actor.userId }))
    return forbidden;
  const parsed = parseProfile(raw);
  if (!parsed.ok)
    return { ok: false, error: "validation", fieldErrors: parsed.fieldErrors };
  const values = parsed.data;

  if (values.governorateId !== null) {
    const found = await db
      .select({ id: governorate.id })
      .from(governorate)
      .where(eq(governorate.id, values.governorateId))
      .limit(1);
    if (found.length === 0)
      return {
        ok: false,
        error: "validation",
        fieldErrors: { governorateId: "invalidChoice" },
      };
  }

  await db
    .insert(profile)
    .values({ ...values, userId: actor.userId })
    .onConflictDoUpdate({
      target: profile.userId,
      set: { ...values, updatedAt: new Date() },
    });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Private professional details

export async function getOwnProfessionalDetails(
  db: Db,
  actor: Actor,
): Promise<OwnProfessionalDetails | null> {
  if (!can(actor, "professionalDetails.read", { ownerId: actor.userId }))
    return null;
  const rows = await db
    .select({
      phoneE164: professionalDetails.phoneE164,
      university: professionalDetails.university,
      graduationYear: professionalDetails.graduationYear,
    })
    .from(professionalDetails)
    .where(eq(professionalDetails.userId, actor.userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertOwnProfessionalDetails(
  db: Db,
  actor: Actor,
  raw: RawForm,
  now: Date = new Date(),
): Promise<WriteResult<ProfessionalDetailsField>> {
  if (!can(actor, "professionalDetails.update", { ownerId: actor.userId }))
    return forbidden;
  const parsed = parseProfessionalDetails(raw, now);
  if (!parsed.ok)
    return { ok: false, error: "validation", fieldErrors: parsed.fieldErrors };
  await db
    .insert(professionalDetails)
    .values({ ...parsed.data, userId: actor.userId })
    .onConflictDoUpdate({
      target: professionalDetails.userId,
      set: { ...parsed.data, updatedAt: new Date() },
    });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Experience (same visibility as the profile; edits are owner only)

const experienceColumns = {
  id: experience.id,
  title: experience.title,
  employerName: experience.employerName,
  startMonth: experience.startMonth,
  endMonth: experience.endMonth,
};

// Current positions first, then most recent.
const experienceOrder = [
  sql`${experience.endMonth} desc nulls first`,
  desc(experience.startMonth),
  desc(experience.createdAt),
];

function experienceOf(db: Db, userId: string) {
  return db
    .select(experienceColumns)
    .from(experience)
    .where(eq(experience.userId, userId))
    .orderBy(...experienceOrder);
}

export async function listOwnExperience(
  db: Db,
  actor: Actor,
): Promise<ExperienceItem[]> {
  if (!can(actor, "profile.update", { ownerId: actor.userId })) return [];
  return experienceOf(db, actor.userId);
}

export async function addOwnExperience(
  db: Db,
  actor: Actor,
  raw: RawForm,
  now: Date = new Date(),
): Promise<WriteResult<ExperienceField>> {
  if (!can(actor, "profile.update", { ownerId: actor.userId }))
    return forbidden;
  const parsed = parseExperience(raw, now);
  if (!parsed.ok)
    return { ok: false, error: "validation", fieldErrors: parsed.fieldErrors };

  return db.transaction(async (tx) => {
    // Serializes concurrent adds for one user so the cap cannot be raced.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`experience:${actor.userId}`}, 0))`,
    );
    const [existing] = await tx
      .select({ n: count() })
      .from(experience)
      .where(eq(experience.userId, actor.userId));
    if ((existing?.n ?? 0) >= LIMITS.experiencePerUser)
      return { ok: false as const, error: "limitReached" as const };
    await tx
      .insert(experience)
      .values({ ...parsed.data, userId: actor.userId });
    return { ok: true as const };
  });
}

export async function updateOwnExperience(
  db: Db,
  actor: Actor,
  experienceId: unknown,
  raw: RawForm,
  now: Date = new Date(),
): Promise<WriteResult<ExperienceField>> {
  if (!can(actor, "profile.update", { ownerId: actor.userId }))
    return forbidden;
  if (!isUuid(experienceId)) return notFound;
  const parsed = parseExperience(raw, now);
  if (!parsed.ok)
    return { ok: false, error: "validation", fieldErrors: parsed.fieldErrors };
  // Scoped by owner: another user's id matches no row.
  const updated = await db
    .update(experience)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(
      and(eq(experience.id, experienceId), eq(experience.userId, actor.userId)),
    )
    .returning({ id: experience.id });
  return updated.length === 1 ? { ok: true } : notFound;
}

export async function deleteOwnExperience(
  db: Db,
  actor: Actor,
  experienceId: unknown,
): Promise<WriteResult> {
  if (!can(actor, "profile.update", { ownerId: actor.userId }))
    return forbidden;
  if (!isUuid(experienceId)) return notFound;
  const deleted = await db
    .delete(experience)
    .where(
      and(eq(experience.id, experienceId), eq(experience.userId, actor.userId)),
    )
    .returning({ id: experience.id });
  return deleted.length === 1 ? { ok: true } : notFound;
}

// ---------------------------------------------------------------------------
// Reading a profile as another member

/**
 * The only way to read someone's profile. Returns null when the profile does
 * not exist, the id is malformed, the viewer is not signed in, or the
 * visibility rule says no, so callers answer all of these the same way (404)
 * and a hidden profile cannot be told apart from a missing one. Private
 * professional details are never selected.
 */
export async function getProfileForViewer(
  db: Db,
  viewer: Actor | null,
  profileId: unknown,
): Promise<ProfileView | null> {
  if (!viewer || !isUuid(profileId)) return null;
  const rows = await db
    .select({
      ...publicProfileColumns,
      governorateCode: governorate.code,
      governorateNameAr: governorate.nameAr,
      governorateNameEn: governorate.nameEn,
    })
    .from(profile)
    .leftJoin(governorate, eq(governorate.id, profile.governorateId))
    .where(eq(profile.id, profileId))
    .limit(1);
  const row = rows[0];
  if (!row || !canViewProfile(viewer, row)) return null;

  const [items, badge] = await Promise.all([
    experienceOf(db, row.userId),
    getVerificationBadge(db, row.userId),
  ]);
  const own = toOwnProfile(row);
  return {
    id: own.id,
    displayName: own.displayName,
    headline: own.headline,
    bio: own.bio,
    careerStage: own.careerStage,
    yearsExperience: own.yearsExperience,
    governorate:
      row.governorateCode && row.governorateNameAr && row.governorateNameEn
        ? {
            code: row.governorateCode,
            nameAr: row.governorateNameAr,
            nameEn: row.governorateNameEn,
          }
        : null,
    specialties: own.specialties,
    openToWork: own.openToWork,
    experience: items.map(({ title, employerName, startMonth, endMonth }) => ({
      title,
      employerName,
      startMonth,
      endMonth,
    })),
    isOwner: row.userId === viewer.userId,
    hidden: own.visibility === "hidden",
    verified: badge === "verified",
  };
}

// ---------------------------------------------------------------------------
// Data export (ADR-003, data rights)

export type DataExport = {
  format: "pharmacist-platform.export";
  version: 1;
  exportedAt: string;
  account: Awaited<ReturnType<typeof getAccountExport>>;
  profile:
    | (Omit<OwnProfile, "governorateId"> & {
        governorate: Omit<Governorate, "id"> | null;
      })
    | null;
  professionalDetails: OwnProfessionalDetails | null;
  experience: Omit<ExperienceItem, "id">[];
  /** Status, claims and masked ID per submission; never the encrypted ID. */
  verification: VerificationExportItem[];
  /** Own memberships and invitations received; no other member's data. */
  organizations: OrganizationsExport;
};

/**
 * Everything the platform holds about the caller from identity, profiles,
 * verification and organizations (masked national ID, never the encrypted value or the photos).
 * Never includes password hashes, session tokens, TOTP secrets or backup
 * codes (identity's export selects explicit columns only).
 */
export async function exportOwnData(
  db: Db,
  actor: Actor,
  now: Date = new Date(),
): Promise<DataExport | null> {
  if (!can(actor, "professionalDetails.read", { ownerId: actor.userId }))
    return null;
  const [account, own, details, items, governorates, verification, orgs] =
    await Promise.all([
      getAccountExport(db, actor.userId),
      getOwnProfile(db, actor),
      getOwnProfessionalDetails(db, actor),
      listOwnExperience(db, actor),
      listGovernorates(db),
      exportOwnVerification(db, actor),
      exportOwnOrganizations(db, actor),
    ]);
  let exportedProfile: DataExport["profile"] = null;
  if (own) {
    const { governorateId, ...rest } = own;
    const g = governorates.find((x) => x.id === governorateId);
    exportedProfile = {
      ...rest,
      governorate: g
        ? { code: g.code, nameAr: g.nameAr, nameEn: g.nameEn }
        : null,
    };
  }
  return {
    format: "pharmacist-platform.export",
    version: 1,
    exportedAt: now.toISOString(),
    account,
    profile: exportedProfile,
    professionalDetails: details,
    experience: items.map(({ title, employerName, startMonth, endMonth }) => ({
      title,
      employerName,
      startMonth,
      endMonth,
    })),
    verification: verification ?? [],
    organizations: orgs,
  };
}

// ---------------------------------------------------------------------------
// Sharing with an employer (ADR-007)

export type ApplicationShare = {
  snapshot: {
    displayName: string;
    headline: string | null;
    bio: string | null;
    careerStage: CareerStage;
    yearsExperience: number;
    governorate: Omit<Governorate, "id"> | null;
    specialties: Specialty[];
    experience: Omit<ExperienceItem, "id">[];
  };
  /** The private phone, for the applicant to opt in to sharing; null if none. */
  phoneE164: string | null;
};

/**
 * What the caller may share when applying for a job: their public profile
 * fields (whatever its visibility; applying is the owner's own choice to
 * share) and their phone. Null when they have no profile yet.
 */
export async function getOwnApplicationShare(
  db: Db,
  actor: Actor,
): Promise<ApplicationShare | null> {
  const own = await getOwnProfile(db, actor);
  if (!own) return null;
  const [items, details, governorates] = await Promise.all([
    listOwnExperience(db, actor),
    getOwnProfessionalDetails(db, actor),
    listGovernorates(db),
  ]);
  const g = governorates.find((x) => x.id === own.governorateId);
  return {
    snapshot: {
      displayName: own.displayName,
      headline: own.headline,
      bio: own.bio,
      careerStage: own.careerStage,
      yearsExperience: own.yearsExperience,
      governorate: g
        ? { code: g.code, nameAr: g.nameAr, nameEn: g.nameEn }
        : null,
      specialties: own.specialties,
      experience: items.map(
        ({ title, employerName, startMonth, endMonth }) => ({
          title,
          employerName,
          startMonth,
          endMonth,
        }),
      ),
    },
    phoneE164: details?.phoneE164 ?? null,
  };
}
