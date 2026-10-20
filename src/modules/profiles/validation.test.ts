import { describe, expect, it } from "vitest";
import {
  cairoYearMonth,
  charLength,
  formDataToRaw,
  isUuid,
  parseExperience,
  parseProfessionalDetails,
  parseProfile,
} from "./validation";

// 2026-10-20 at noon in Cairo.
const NOW = new Date("2026-10-20T10:00:00Z");

const validProfile = {
  displayName: "د. سارة أحمد",
  headline: "صيدلانية مجتمع",
  bio: "",
  careerStage: "pharmacist",
  yearsExperience: "5",
  governorateId: "1",
  specialties: ["community"],
  openToWork: "on",
  visibility: "members",
};

describe("parseProfile", () => {
  it("accepts a complete profile and normalizes it", () => {
    const result = parseProfile({
      ...validProfile,
      displayName: "  د.   سـارة   أحمد ",
      headline: "  ",
      specialties: ["other", "community", "community"],
    });
    expect(result).toEqual({
      ok: true,
      data: {
        displayName: "د. سارة أحمد",
        headline: null,
        bio: null,
        careerStage: "pharmacist",
        yearsExperience: 5,
        governorateId: 1,
        specialties: ["community", "other"],
        openToWork: true,
        visibility: "members",
      },
    });
  });

  it("accepts Eastern Arabic and Persian digits in numeric fields", () => {
    const arabic = parseProfile({
      ...validProfile,
      yearsExperience: "١٢",
      governorateId: "٢٧",
    });
    expect(arabic.ok && arabic.data.yearsExperience).toBe(12);
    expect(arabic.ok && arabic.data.governorateId).toBe(27);
    const persian = parseProfile({ ...validProfile, yearsExperience: "۶۰" });
    expect(persian.ok && persian.data.yearsExperience).toBe(60);
  });

  it("checks years of experience is a whole number from 0 to 60", () => {
    const code = (yearsExperience: string) => {
      const r = parseProfile({ ...validProfile, yearsExperience });
      return r.ok ? null : r.fieldErrors.yearsExperience;
    };
    expect(code("0")).toBeNull();
    expect(code("60")).toBeNull();
    expect(code("61")).toBe("outOfRange");
    expect(code("-1")).toBe("invalidNumber");
    expect(code("2.5")).toBe("invalidNumber");
    expect(code("abc")).toBe("invalidNumber");
    expect(code("")).toBe("required");
  });

  it("requires a display name of 2 to 80 characters", () => {
    const code = (displayName: unknown) => {
      const r = parseProfile({ ...validProfile, displayName });
      return r.ok ? null : r.fieldErrors.displayName;
    };
    expect(code("   ")).toBe("required");
    expect(code(undefined)).toBe("required");
    expect(code("أ")).toBe("tooShort");
    expect(code("ـأـ")).toBe("tooShort");
    expect(code("أ".repeat(80))).toBeNull();
    expect(code("أ".repeat(81))).toBe("tooLong");
    expect(code("Sara سارة")).toBeNull();
  });

  it("limits headline and bio length in characters", () => {
    const r1 = parseProfile({ ...validProfile, headline: "x".repeat(121) });
    expect(!r1.ok && r1.fieldErrors.headline).toBe("tooLong");
    const r2 = parseProfile({ ...validProfile, bio: "ب".repeat(1001) });
    expect(!r2.ok && r2.fieldErrors.bio).toBe("tooLong");
    // Emoji count as one character each, as in PostgreSQL.
    const r3 = parseProfile({ ...validProfile, bio: "💊".repeat(1000) });
    expect(r3.ok).toBe(true);
  });

  it("keeps line breaks in the bio but collapses blank runs", () => {
    const r = parseProfile({
      ...validProfile,
      bio: " سطر أول \r\n\r\n\r\n\r\nسطر   ثانٍ \u0007",
    });
    expect(r.ok && r.data.bio).toBe("سطر أول\n\nسطر ثانٍ");
  });

  it("only accepts the allowed specialties, career stages and visibilities", () => {
    const s = parseProfile({
      ...validProfile,
      specialties: ["community", "x"],
    });
    expect(!s.ok && s.fieldErrors.specialties).toBe("invalidChoice");
    const single = parseProfile({ ...validProfile, specialties: "hospital" });
    expect(single.ok && single.data.specialties).toEqual(["hospital"]);
    const none = parseProfile({ ...validProfile, specialties: undefined });
    expect(none.ok && none.data.specialties).toEqual([]);
    const c = parseProfile({ ...validProfile, careerStage: "owner" });
    expect(!c.ok && c.fieldErrors.careerStage).toBe("invalidChoice");
    const c2 = parseProfile({ ...validProfile, careerStage: "" });
    expect(!c2.ok && c2.fieldErrors.careerStage).toBe("required");
    const v = parseProfile({ ...validProfile, visibility: "public" });
    expect(!v.ok && v.fieldErrors.visibility).toBe("invalidChoice");
  });

  it("treats an empty governorate as none and rejects garbage", () => {
    const empty = parseProfile({ ...validProfile, governorateId: "" });
    expect(empty.ok && empty.data.governorateId).toBeNull();
    const bad = parseProfile({ ...validProfile, governorateId: "cairo" });
    expect(!bad.ok && bad.fieldErrors.governorateId).toBe("invalidNumber");
    const zero = parseProfile({ ...validProfile, governorateId: "0" });
    expect(!zero.ok && zero.fieldErrors.governorateId).toBe("outOfRange");
  });

  it("ignores fields it does not know, such as an owner id", () => {
    const r = parseProfile({ ...validProfile, userId: "someone-else" });
    expect(r.ok && Object.keys(r.data)).not.toContain("userId");
  });

  it("reports every invalid field at once", () => {
    const r = parseProfile({});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fieldErrors).toMatchObject({
        displayName: "required",
        careerStage: "required",
        yearsExperience: "required",
        visibility: "required",
      });
    }
  });
});

describe("parseProfessionalDetails", () => {
  it("normalizes the phone to E.164, Arabic digits included", () => {
    const r = parseProfessionalDetails(
      {
        phone: "٠١٠١٢٣٤٥٦٧٨",
        university: " جامعة  القاهرة ",
        graduationYear: "٢٠٢٠",
      },
      NOW,
    );
    expect(r).toEqual({
      ok: true,
      data: {
        phoneE164: "+201012345678",
        university: "جامعة القاهرة",
        graduationYear: 2020,
      },
    });
  });

  it("allows every field to be empty", () => {
    expect(parseProfessionalDetails({}, NOW)).toEqual({
      ok: true,
      data: { phoneE164: null, university: null, graduationYear: null },
    });
  });

  it("rejects invalid phones and out-of-range graduation years", () => {
    const phone = parseProfessionalDetails({ phone: "01312345678" }, NOW);
    expect(!phone.ok && phone.fieldErrors.phone).toBe("invalidPhone");
    const code = (graduationYear: string) => {
      const r = parseProfessionalDetails({ graduationYear }, NOW);
      return r.ok ? null : r.fieldErrors.graduationYear;
    };
    expect(code("1959")).toBe("outOfRange");
    expect(code("1960")).toBeNull();
    // Students may enter an expected year up to 7 years ahead.
    expect(code("2033")).toBeNull();
    expect(code("2034")).toBe("outOfRange");
    expect(code("20x0")).toBe("invalidNumber");
  });

  it("limits the university name", () => {
    const r = parseProfessionalDetails({ university: "ج".repeat(121) }, NOW);
    expect(!r.ok && r.fieldErrors.university).toBe("tooLong");
  });
});

describe("parseExperience", () => {
  const base = {
    title: "صيدلي",
    employerName: "صيدلية النور",
    startMonth: "3",
    startYear: "2020",
    endMonth: "6",
    endYear: "2022",
  };

  it("builds first-of-month dates", () => {
    expect(parseExperience(base, NOW)).toEqual({
      ok: true,
      data: {
        title: "صيدلي",
        employerName: "صيدلية النور",
        startMonth: "2020-03-01",
        endMonth: "2022-06-01",
      },
    });
  });

  it("accepts Arabic digits and a current position without an end", () => {
    const r = parseExperience(
      {
        ...base,
        startMonth: "١٠",
        startYear: "٢٠٢٦",
        current: "on",
        endMonth: "",
        endYear: "",
      },
      NOW,
    );
    expect(r).toEqual({
      ok: true,
      data: {
        title: "صيدلي",
        employerName: "صيدلية النور",
        startMonth: "2026-10-01",
        endMonth: null,
      },
    });
  });

  it("rejects invalid months", () => {
    for (const startMonth of ["0", "13", "x", "1.5"]) {
      const r = parseExperience({ ...base, startMonth }, NOW);
      expect(!r.ok && r.fieldErrors.startMonth, startMonth).toBe(
        "invalidMonth",
      );
    }
    const missing = parseExperience({ ...base, endMonth: "" }, NOW);
    expect(!missing.ok && missing.fieldErrors.endMonth).toBe("required");
  });

  it("rejects an end before the start and dates in the future", () => {
    const before = parseExperience(
      { ...base, endMonth: "2", endYear: "2020" },
      NOW,
    );
    expect(!before.ok && before.fieldErrors.endMonth).toBe("endBeforeStart");
    const sameMonth = parseExperience(
      { ...base, endMonth: "3", endYear: "2020" },
      NOW,
    );
    expect(sameMonth.ok).toBe(true);
    const future = parseExperience(
      { ...base, startMonth: "11", startYear: "2026", current: "on" },
      NOW,
    );
    expect(!future.ok && future.fieldErrors.startMonth).toBe("inFuture");
    const year = parseExperience({ ...base, endYear: "2027" }, NOW);
    expect(!year.ok && year.fieldErrors.endYear).toBe("outOfRange");
    const early = parseExperience({ ...base, startYear: "1959" }, NOW);
    expect(!early.ok && early.fieldErrors.startYear).toBe("outOfRange");
  });

  it("requires a title and employer within 120 characters", () => {
    const r = parseExperience(
      { ...base, title: " ", employerName: "ص".repeat(121) },
      NOW,
    );
    expect(!r.ok && r.fieldErrors).toEqual({
      title: "required",
      employerName: "tooLong",
    });
  });
});

describe("helpers", () => {
  it("cairoYearMonth uses Africa/Cairo, not UTC", () => {
    // 22:30 UTC on 31 October is already 1 November in Cairo (UTC+2 or +3).
    expect(cairoYearMonth(new Date("2026-10-31T22:30:00Z"))).toEqual({
      year: 2026,
      month: 11,
    });
  });

  it("charLength counts code points", () => {
    expect(charLength("💊a")).toBe(2);
  });

  it("formDataToRaw collects checkbox groups and skips action fields", () => {
    const form = new FormData();
    form.append("displayName", "سارة");
    form.append("specialties", "community");
    form.append("specialties", "hospital");
    form.append("$ACTION_ID_abc", "");
    expect(formDataToRaw(form, ["specialties", "other"])).toEqual({
      displayName: "سارة",
      specialties: ["community", "hospital"],
      other: [],
    });
  });

  it("isUuid only accepts UUIDs", () => {
    expect(isUuid("6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f")).toBe(true);
    expect(isUuid("1")).toBe(false);
    expect(isUuid("6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f' or 1=1")).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });
});
