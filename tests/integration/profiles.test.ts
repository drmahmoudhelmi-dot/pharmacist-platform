import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Actor, actorFromSession } from "@/modules/identity/policy";
import { changeRole, listRoles } from "@/modules/identity/roles-service";
import { user } from "@/modules/identity/schema";
import { LIMITS } from "@/modules/profiles/constants";
import {
  experience,
  professionalDetails,
  profile,
} from "@/modules/profiles/schema";
import {
  addOwnExperience,
  deleteOwnExperience,
  exportOwnData,
  getOwnProfessionalDetails,
  getOwnProfile,
  getProfileForViewer,
  listGovernorates,
  listOwnExperience,
  updateOwnExperience,
  upsertOwnProfessionalDetails,
  upsertOwnProfile,
} from "@/modules/profiles/service";
import { type Harness, startHarness } from "./helpers/auth-harness";
import { totpFromUri } from "./helpers/totp";

const PASSWORD = "correct horse battery staple";
const NOW = new Date("2026-10-20T10:00:00Z");
let h: Harness;
let counter = 0;

/** A real verified user, signed in; the Actor is built from its session. */
async function member(label: string) {
  counter += 1;
  const email = `${label}-${counter}@example.test`;
  await h.createVerifiedUser(email, PASSWORD);
  const signedIn = await h.signIn(email, PASSWORD);
  const current = await h.call("/get-session", { jar: signedIn.jar });
  const session = current.json as unknown as Parameters<
    typeof actorFromSession
  >[0];
  const actor: Actor = actorFromSession(
    session,
    await listRoles(h.db, session.user.id),
  );
  return { email, actor, jar: signedIn.jar };
}

const profileForm = {
  displayName: "د. سارة أحمد",
  headline: "صيدلانية مجتمع",
  bio: "خبرة في صرف الأدوية وتقديم الاستشارات.",
  careerStage: "pharmacist",
  yearsExperience: "٥",
  governorateId: "١",
  specialties: ["community", "clinical"],
  openToWork: "on",
  visibility: "members",
};

const detailsForm = {
  phone: "٠١٠١٢٣٤٥٦٧٨",
  university: "جامعة القاهرة",
  graduationYear: "2018",
};

const experienceForm = {
  title: "صيدلي أول",
  employerName: "صيدلية النور",
  startMonth: "3",
  startYear: "2019",
  endMonth: "6",
  endYear: "2022",
};

async function profileIdOf(actor: Actor) {
  const own = await getOwnProfile(h.db, actor);
  if (!own) throw new Error("no profile");
  return own.id;
}

async function experienceIdsOf(actor: Actor) {
  return (await listOwnExperience(h.db, actor)).map((e) => e.id);
}

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.stop();
});

describe("governorate reference data", () => {
  it("seeds exactly Egypt's 27 governorates with unique codes and names", async () => {
    const rows = await listGovernorates(h.db);
    expect(rows).toHaveLength(27);
    expect(rows.map((r) => r.id)).toEqual(
      Array.from({ length: 27 }, (_, i) => i + 1),
    );
    expect(new Set(rows.map((r) => r.code)).size).toBe(27);
    expect(new Set(rows.map((r) => r.nameAr)).size).toBe(27);
    expect(rows[0]).toEqual({
      id: 1,
      code: "EG-C",
      nameAr: "القاهرة",
      nameEn: "Cairo",
    });
    for (const r of rows) expect(r.code).toMatch(/^EG-[A-Z]{1,3}$/);
  });
});

describe("own profile", () => {
  it("shows no profile until the first save, then creates and updates it", async () => {
    const { actor } = await member("owner");
    expect(await getOwnProfile(h.db, actor)).toBeNull();

    expect(await upsertOwnProfile(h.db, actor, profileForm)).toEqual({
      ok: true,
    });
    const created = await getOwnProfile(h.db, actor);
    expect(created).toMatchObject({
      displayName: "د. سارة أحمد",
      careerStage: "pharmacist",
      yearsExperience: 5,
      governorateId: 1,
      specialties: ["community", "clinical"],
      openToWork: true,
      visibility: "members",
    });
    // The public id is not the auth user id.
    expect(created?.id).not.toBe(actor.userId);

    expect(
      await upsertOwnProfile(h.db, actor, {
        ...profileForm,
        displayName: "سارة",
        yearsExperience: "6",
        openToWork: undefined,
        specialties: [],
        governorateId: "",
      }),
    ).toEqual({ ok: true });
    const updated = await getOwnProfile(h.db, actor);
    expect(updated).toMatchObject({
      id: created?.id,
      displayName: "سارة",
      yearsExperience: 6,
      openToWork: false,
      specialties: [],
      governorateId: null,
    });
    const rows = await h.db
      .select()
      .from(profile)
      .where(eq(profile.userId, actor.userId));
    expect(rows).toHaveLength(1);
  });

  it("returns field errors and writes nothing on invalid input", async () => {
    const { actor } = await member("invalid");
    const result = await upsertOwnProfile(h.db, actor, {
      ...profileForm,
      yearsExperience: "٦١",
      specialties: ["community", "astrology"],
    });
    expect(result).toEqual({
      ok: false,
      error: "validation",
      fieldErrors: {
        yearsExperience: "outOfRange",
        specialties: "invalidChoice",
      },
    });
    const unknownGovernorate = await upsertOwnProfile(h.db, actor, {
      ...profileForm,
      governorateId: "28",
    });
    expect(unknownGovernorate).toEqual({
      ok: false,
      error: "validation",
      fieldErrors: { governorateId: "invalidChoice" },
    });
    expect(await getOwnProfile(h.db, actor)).toBeNull();
  });

  it("ignores an owner id smuggled into the input", async () => {
    const a = await member("smuggler");
    const b = await member("victim");
    await upsertOwnProfile(h.db, b.actor, profileForm);
    await upsertOwnProfile(h.db, a.actor, {
      ...profileForm,
      displayName: "Mallory",
      userId: b.actor.userId,
      user_id: b.actor.userId,
    });
    expect((await getOwnProfile(h.db, b.actor))?.displayName).toBe(
      "د. سارة أحمد",
    );
    expect((await getOwnProfile(h.db, a.actor))?.displayName).toBe("Mallory");
  });
});

describe("professional details are private", () => {
  it("only the owner reads them; another user's call reads their own row", async () => {
    const a = await member("details-a");
    const b = await member("details-b");
    expect(
      await upsertOwnProfessionalDetails(h.db, b.actor, detailsForm, NOW),
    ).toEqual({ ok: true });
    expect(await getOwnProfessionalDetails(h.db, b.actor)).toEqual({
      phoneE164: "+201012345678",
      university: "جامعة القاهرة",
      graduationYear: 2018,
    });
    // There is no parameter to name another user: A only ever gets A's row.
    expect(await getOwnProfessionalDetails(h.db, a.actor)).toBeNull();
    // A staff role with MFA does not open them either.
    const unverified: Actor = { ...b.actor, emailVerified: false };
    expect(await getOwnProfessionalDetails(h.db, unverified)).toBeNull();
    expect(
      await upsertOwnProfessionalDetails(h.db, unverified, detailsForm, NOW),
    ).toEqual({ ok: false, error: "forbidden" });
  });

  it("validates the phone with the Egyptian mobile rules", async () => {
    const { actor } = await member("details-phone");
    expect(
      await upsertOwnProfessionalDetails(
        h.db,
        actor,
        { ...detailsForm, phone: "0131234567" },
        NOW,
      ),
    ).toEqual({
      ok: false,
      error: "validation",
      fieldErrors: { phone: "invalidPhone" },
    });
  });
});

describe("experience across users", () => {
  it("user A cannot update or delete user B's experience by id", async () => {
    const a = await member("exp-a");
    const b = await member("exp-b");
    expect(await addOwnExperience(h.db, b.actor, experienceForm, NOW)).toEqual({
      ok: true,
    });
    const [bId] = await experienceIdsOf(b.actor);

    expect(
      await updateOwnExperience(
        h.db,
        a.actor,
        bId,
        { ...experienceForm, title: "hijacked" },
        NOW,
      ),
    ).toEqual({ ok: false, error: "notFound" });
    expect(await deleteOwnExperience(h.db, a.actor, bId)).toEqual({
      ok: false,
      error: "notFound",
    });
    expect(await listOwnExperience(h.db, a.actor)).toEqual([]);
    const [still] = await listOwnExperience(h.db, b.actor);
    expect(still?.title).toBe("صيدلي أول");

    // The owner can.
    expect(
      await updateOwnExperience(
        h.db,
        b.actor,
        bId,
        { ...experienceForm, title: "مدير صيدلية", current: "on" },
        NOW,
      ),
    ).toEqual({ ok: true });
    expect((await listOwnExperience(h.db, b.actor))[0]).toMatchObject({
      title: "مدير صيدلية",
      startMonth: "2019-03-01",
      endMonth: null,
    });
    expect(await deleteOwnExperience(h.db, b.actor, bId)).toEqual({ ok: true });
    expect(await listOwnExperience(h.db, b.actor)).toEqual([]);
  });

  it("answers malformed ids as not found without querying", async () => {
    const { actor } = await member("exp-bad-id");
    for (const id of ["1", "'; drop table experience; --", undefined, 42]) {
      expect(await deleteOwnExperience(h.db, actor, id)).toEqual({
        ok: false,
        error: "notFound",
      });
    }
  });

  it("rejects the 31st entry, also when added concurrently", async () => {
    const { actor } = await member("exp-cap");
    const results = await Promise.all(
      Array.from({ length: LIMITS.experiencePerUser + 5 }, () =>
        addOwnExperience(h.db, actor, experienceForm, NOW),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(LIMITS.experiencePerUser);
    expect(results.filter((r) => !r.ok)).toEqual(
      Array(5).fill({ ok: false, error: "limitReached" }),
    );
    expect(await addOwnExperience(h.db, actor, experienceForm, NOW)).toEqual({
      ok: false,
      error: "limitReached",
    });
    expect(await experienceIdsOf(actor)).toHaveLength(30);
  });
});

describe("visibility", () => {
  it("members see a members profile; a hidden one only its owner sees, exactly like a missing one", async () => {
    const owner = await member("vis-owner");
    const other = await member("vis-other");
    await upsertOwnProfile(h.db, owner.actor, profileForm);
    await upsertOwnProfessionalDetails(h.db, owner.actor, detailsForm, NOW);
    await addOwnExperience(h.db, owner.actor, experienceForm, NOW);
    const id = await profileIdOf(owner.actor);

    const seen = await getProfileForViewer(h.db, other.actor, id);
    expect(seen).toMatchObject({
      id,
      displayName: "د. سارة أحمد",
      governorate: { code: "EG-C", nameAr: "القاهرة", nameEn: "Cairo" },
      isOwner: false,
      hidden: false,
      experience: [
        {
          title: "صيدلي أول",
          employerName: "صيدلية النور",
          startMonth: "2019-03-01",
          endMonth: "2022-06-01",
        },
      ],
    });
    // Signed-out visitors never see profiles.
    expect(await getProfileForViewer(h.db, null, id)).toBeNull();

    await upsertOwnProfile(h.db, owner.actor, {
      ...profileForm,
      visibility: "hidden",
    });
    const hidden = await getProfileForViewer(h.db, other.actor, id);
    const missing = await getProfileForViewer(
      h.db,
      other.actor,
      "00000000-0000-4000-8000-000000000000",
    );
    expect(hidden).toBeNull();
    expect(missing).toBeNull();
    expect(await getProfileForViewer(h.db, other.actor, "garbage")).toBeNull();

    const ownView = await getProfileForViewer(h.db, owner.actor, id);
    expect(ownView).toMatchObject({ isOwner: true, hidden: true });
  });

  it("staff roles do not reveal hidden profiles", async () => {
    const owner = await member("vis-staff-owner");
    await upsertOwnProfile(h.db, owner.actor, {
      ...profileForm,
      visibility: "hidden",
    });
    const id = await profileIdOf(owner.actor);
    const s = await member("vis-staff");
    await changeRole(h.db, {
      email: s.email,
      role: "moderator",
      change: "grant",
    });
    const signedIn = await h.signIn(s.email, PASSWORD);
    const enable = await h.call("/two-factor/enable", {
      body: { password: PASSWORD },
      jar: signedIn.jar,
    });
    await h.call("/two-factor/verify-totp", {
      body: { code: totpFromUri(enable.json?.totpURI as string) },
      jar: signedIn.jar,
    });
    const current = await h.call("/get-session", { jar: signedIn.jar });
    const session = current.json as unknown as Parameters<
      typeof actorFromSession
    >[0];
    const staff = actorFromSession(
      session,
      await listRoles(h.db, session.user.id),
    );
    expect(staff.roles).toEqual(["moderator"]);
    expect(staff.mfaSatisfied).toBe(true);
    expect(await getProfileForViewer(h.db, staff, id)).toBeNull();
  });

  it("the viewer response never contains private details or the user id", async () => {
    const owner = await member("vis-private");
    const other = await member("vis-private-viewer");
    await upsertOwnProfile(h.db, owner.actor, profileForm);
    await upsertOwnProfessionalDetails(h.db, owner.actor, detailsForm, NOW);
    const id = await profileIdOf(owner.actor);
    for (const viewer of [other.actor, owner.actor]) {
      const view = await getProfileForViewer(h.db, viewer, id);
      expect(view).not.toBeNull();
      const json = JSON.stringify(view);
      expect(json).not.toContain("+201012345678");
      expect(json).not.toContain("01012345678");
      expect(json).not.toContain("جامعة القاهرة");
      expect(json).not.toContain("2018");
      expect(json).not.toContain(owner.actor.userId);
      expect(json).not.toContain(owner.email);
      for (const key of [
        "phone",
        "phoneE164",
        "university",
        "graduationYear",
        "userId",
        "email",
      ])
        expect(view).not.toHaveProperty(key);
    }
  });
});

describe("database constraints", () => {
  async function userId() {
    return (await member("db")).actor.userId;
  }

  it("enforces the specialties CHECK", async () => {
    const id = await userId();
    for (const specialties of [
      "{astrology}",
      "{community,astrology}",
      "{community,NULL}",
    ]) {
      await expect(
        h.pool.query(
          "insert into profile (user_id, display_name, career_stage, specialties) values ($1, 'سارة', 'student', $2)",
          [id, specialties],
        ),
        specialties,
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "profile_specialties_check",
      });
    }
    await h.pool.query(
      "insert into profile (user_id, display_name, career_stage, specialties) values ($1, 'سارة', 'student', '{community,medical_rep}')",
      [id],
    );
  });

  it("enforces career_stage, visibility and years CHECKs and one profile per user", async () => {
    const id = await userId();
    const insert = (columns: string, values: string) =>
      h.pool.query(
        `insert into profile (user_id, display_name, ${columns}) values ($1, 'سارة', ${values})`,
        [id],
      );
    await expect(insert("career_stage", "'owner'")).rejects.toMatchObject({
      code: "23514",
      constraint: "profile_career_stage_check",
    });
    await expect(
      insert("career_stage, visibility", "'student', 'public'"),
    ).rejects.toMatchObject({ constraint: "profile_visibility_check" });
    await expect(
      insert("career_stage, years_experience", "'student', 61"),
    ).rejects.toMatchObject({ constraint: "profile_years_experience_check" });
    await expect(
      insert("career_stage, governorate_id", "'student', 99"),
    ).rejects.toMatchObject({ code: "23503" });
    await insert("career_stage", "'student'");
    await expect(insert("career_stage", "'graduate'")).rejects.toMatchObject({
      code: "23505",
      constraint: "profile_user_id_unique",
    });
  });

  it("enforces experience end >= start and first-of-month dates", async () => {
    const id = await userId();
    const insert = (start: string, end: string | null) =>
      h.pool.query(
        "insert into experience (user_id, title, employer_name, start_month, end_month) values ($1, 'صيدلي', 'صيدلية', $2, $3)",
        [id, start, end],
      );
    await expect(insert("2022-06-01", "2022-05-01")).rejects.toMatchObject({
      code: "23514",
      constraint: "experience_end_after_start_check",
    });
    await expect(insert("2022-06-15", null)).rejects.toMatchObject({
      constraint: "experience_months_check",
    });
    await insert("2022-06-01", "2022-06-01");
    await insert("2022-06-01", null);
  });

  it("enforces the phone format on professional details", async () => {
    const id = await userId();
    await expect(
      h.pool.query(
        "insert into professional_details (user_id, phone_e164) values ($1, '01012345678')",
        [id],
      ),
    ).rejects.toMatchObject({ constraint: "professional_details_phone_check" });
  });
});

describe("data export", () => {
  it("contains the user's data and no secret fields", async () => {
    const { actor, email, jar } = await member("export");
    // Give the account every kind of secret the identity tables hold.
    const enable = await h.call("/two-factor/enable", {
      body: { password: PASSWORD },
      jar,
    });
    const backupCodes = enable.json?.backupCodes as string[];
    const totpUri = enable.json?.totpURI as string;
    await h.call("/two-factor/verify-totp", {
      body: { code: totpFromUri(totpUri) },
      jar,
    });
    await upsertOwnProfile(h.db, actor, profileForm);
    await upsertOwnProfessionalDetails(h.db, actor, detailsForm, NOW);
    await addOwnExperience(h.db, actor, experienceForm, NOW);

    const data = await exportOwnData(h.db, actor, NOW);
    expect(data).toMatchObject({
      format: "pharmacist-platform.export",
      version: 1,
      exportedAt: NOW.toISOString(),
      account: {
        id: actor.userId,
        email,
        emailVerified: true,
        twoFactorEnabled: true,
        roles: [],
      },
      profile: {
        displayName: "د. سارة أحمد",
        governorate: { code: "EG-C" },
        specialties: ["community", "clinical"],
      },
      professionalDetails: {
        phoneE164: "+201012345678",
        university: "جامعة القاهرة",
        graduationYear: 2018,
      },
      experience: [{ title: "صيدلي أول", startMonth: "2019-03-01" }],
    });

    const json = JSON.stringify(data);
    const secrets = await h.pool.query<{
      password: string;
      token: string;
      secret: string;
      backup_codes: string;
    }>(
      `select a.password, s.token, t.secret, t.backup_codes
         from account a
         join session s on s.user_id = a.user_id
         join two_factor t on t.user_id = a.user_id
        where a.user_id = $1`,
      [actor.userId],
    );
    expect(secrets.rows.length).toBeGreaterThan(0);
    for (const row of secrets.rows) {
      expect(json).not.toContain(row.password);
      expect(json).not.toContain(row.token);
      expect(json).not.toContain(row.secret);
      expect(json).not.toContain(row.backup_codes);
    }
    for (const code of backupCodes) expect(json).not.toContain(code);
    const totpSecret = new URL(totpUri).searchParams.get("secret")!;
    expect(json).not.toContain(totpSecret);
    for (const key of [
      "password",
      "token",
      "secret",
      "backupCodes",
      "backup_codes",
      "session",
      "sessions",
    ])
      expect(json).not.toContain(`"${key}"`);
  });

  it("returns null for an unverified actor", async () => {
    const { actor } = await member("export-denied");
    expect(
      await exportOwnData(h.db, { ...actor, emailVerified: false }, NOW),
    ).toBeNull();
  });
});

describe("account deletion cascades", () => {
  it("removes the profile, details and experience with the user", async () => {
    const { actor } = await member("cascade");
    await upsertOwnProfile(h.db, actor, profileForm);
    await upsertOwnProfessionalDetails(h.db, actor, detailsForm, NOW);
    await addOwnExperience(h.db, actor, experienceForm, NOW);
    await h.db.delete(user).where(eq(user.id, actor.userId));
    for (const [table, column] of [
      [profile, profile.userId],
      [professionalDetails, professionalDetails.userId],
      [experience, experience.userId],
    ] as const) {
      const rows = await h.db
        .select()
        .from(table)
        .where(eq(column, actor.userId));
      expect(rows).toHaveLength(0);
    }
    // Reference data is untouched.
    expect(await listGovernorates(h.db)).toHaveLength(27);
  });
});
