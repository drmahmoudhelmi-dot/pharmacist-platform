import { describe, expect, it } from "vitest";
import {
  ageOn,
  cairoToday,
  GOVERNORATE_CODES,
  maskNationalId,
  normalizeNationalId,
  parseNationalId,
} from "./national-id";

// Synthetic numbers only: built from the documented structure, not real IDs.
// C YYMMDD GG SSSS K
const id = (century: string, yymmdd: string, gov = "01", rest = "12345") =>
  `${century}${yymmdd}${gov}${rest}`;

// 21 October 2026, 12:00 in Cairo.
const NOW = new Date("2026-10-21T09:00:00Z");

describe("parseNationalId", () => {
  it("accepts a valid 1900s and 2000s ID and reads the birth date", () => {
    expect(parseNationalId(id("2", "900315"), NOW)).toEqual({
      ok: true,
      data: {
        value: "29003150112345",
        birthDate: "1990-03-15",
        governorateCode: "01",
      },
    });
    const young = parseNationalId(id("3", "050101", "88"), NOW);
    expect(young).toMatchObject({
      ok: true,
      data: { birthDate: "2005-01-01", governorateCode: "88" },
    });
  });

  it("normalizes Eastern Arabic and Persian digits, spaces, dashes and bidi marks", () => {
    expect(normalizeNationalId("٢٩٠٠٣١٥٠١١٢٣٤٥")).toBe("29003150112345");
    expect(normalizeNationalId("۲۹۰۰۳۱۵۰۱۱۲۳۴۵")).toBe("29003150112345");
    expect(normalizeNationalId(" 2 900315-01-12345‏ ")).toBe("29003150112345");
    expect(parseNationalId("٢٩٠٠٣١٥٠١١٢٣٤٥", NOW).ok).toBe(true);
    expect(normalizeNationalId(42)).toBe("");
  });

  it("requires exactly 14 digits", () => {
    expect(parseNationalId("", NOW)).toEqual({ ok: false, error: "required" });
    expect(parseNationalId(undefined, NOW)).toEqual({
      ok: false,
      error: "required",
    });
    for (const bad of [
      "2900315011234",
      "290031501123456",
      "2900315011234a",
      "29OO315O112345",
    ])
      expect(parseNationalId(bad, NOW)).toEqual({
        ok: false,
        error: "invalidFormat",
      });
  });

  it("accepts only century digits 2 and 3", () => {
    for (const c of ["0", "1", "4", "9"])
      expect(parseNationalId(id(c, "900315"), NOW)).toEqual({
        ok: false,
        error: "invalidCentury",
      });
  });

  it("refuses impossible and future birth dates", () => {
    for (const yymmdd of [
      "901315", // month 13
      "900015", // month 0
      "900200", // day 0
      "900230", // 30 February
      "910229", // 29 February 1991 (not a leap year)
      "900431", // 31 April
    ])
      expect(parseNationalId(id("2", yymmdd), NOW)).toEqual({
        ok: false,
        error: "invalidBirthDate",
      });
    // 29 February in a leap year is fine.
    expect(parseNationalId(id("2", "920229"), NOW).ok).toBe(true);
    // Born after today (2000s century digit).
    expect(parseNationalId(id("3", "261022"), NOW)).toEqual({
      ok: false,
      error: "invalidBirthDate",
    });
  });

  it("requires an age of 17 to 90 on today's date in Cairo", () => {
    // Turns 17 today → allowed; turns 17 tomorrow → refused.
    expect(parseNationalId(id("3", "091021"), NOW).ok).toBe(true);
    expect(parseNationalId(id("3", "091022"), NOW)).toEqual({
      ok: false,
      error: "ageOutOfRange",
    });
    // 90 until the day before the 91st birthday.
    expect(parseNationalId(id("2", "351022"), NOW).ok).toBe(true);
    expect(parseNationalId(id("2", "351021"), NOW)).toEqual({
      ok: false,
      error: "ageOutOfRange",
    });
    expect(parseNationalId(id("2", "200101"), NOW)).toEqual({
      ok: false,
      error: "ageOutOfRange",
    });
  });

  it("counts the day in Cairo, not UTC", () => {
    // 21:30 UTC on 20 October is already 21 October in Cairo (UTC+3 in DST
    // until the last Friday of October 2026).
    const lateUtc = new Date("2026-10-20T21:30:00Z");
    expect(cairoToday(lateUtc)).toBe("2026-10-21");
    expect(parseNationalId(id("3", "091021"), lateUtc).ok).toBe(true);
    // In winter (UTC+2) 21:30 UTC is 23:30 in Cairo, still the same day.
    expect(cairoToday(new Date("2026-12-20T21:30:00Z"))).toBe("2026-12-20");
  });

  it("accepts every listed governorate code and refuses the rest", () => {
    expect(GOVERNORATE_CODES).toHaveLength(28);
    for (const gov of GOVERNORATE_CODES)
      expect(parseNationalId(id("2", "900315", gov), NOW).ok).toBe(true);
    for (const gov of ["00", "05", "10", "20", "30", "36", "87", "89", "99"])
      expect(parseNationalId(id("2", "900315", gov), NOW)).toEqual({
        ok: false,
        error: "invalidGovernorate",
      });
  });

  it("does not validate the check digit", () => {
    for (const last of "0123456789")
      expect(
        parseNationalId(id("2", "900315", "01", `1234${last}`), NOW).ok,
      ).toBe(true);
  });
});

describe("ageOn", () => {
  it("counts whole years", () => {
    const birth = { y: 2000, m: 2, d: 29 };
    expect(ageOn(birth, { y: 2017, m: 2, d: 28 })).toBe(16);
    expect(ageOn(birth, { y: 2017, m: 3, d: 1 })).toBe(17);
  });
});

describe("maskNationalId", () => {
  it("keeps the first digit and the last three", () => {
    expect(maskNationalId("29003150112345")).toBe("2**********345");
    expect(maskNationalId("30501018812999")).toBe("3**********999");
  });

  it("refuses anything that is not 14 digits", () => {
    expect(() => maskNationalId("2900315011234")).toThrow();
    expect(() => maskNationalId("٢٩٠٠٣١٥٠١١٢٣٤٥")).toThrow();
  });
});
