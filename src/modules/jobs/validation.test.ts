import { describe, expect, it } from "vitest";
import { normalizeForSearch } from "@/shared/text/search";
import { canTransition, JOB_STATUSES, TRANSITIONS } from "./constants";
import { parseDecision, parseJob, parseSearch } from "./validation";

const NOW = new Date("2026-10-26T10:00:00Z");
const valid = {
  title: " صيدلي   مجتمع ",
  category: "pharmacist",
  employmentType: "part_time",
  governorateId: "٢",
  area: "",
  description: "نبحث عن صيدلي للعمل نصف دوام في صيدلية مجتمع بالجيزة.",
  minYearsExperience: "",
  careerStages: ["pharmacist"],
  salaryMin: "٥٬٠٠٠",
  salaryMax: "",
};

describe("parseJob", () => {
  it("normalizes text, digits and salary (pounds to piasters)", () => {
    expect(parseJob(valid, NOW)).toEqual({
      ok: true,
      data: {
        title: "صيدلي مجتمع",
        category: "pharmacist",
        employmentType: "part_time",
        startDate: null,
        endDate: null,
        governorateId: 2,
        area: null,
        description: valid.description,
        minYearsExperience: 0,
        careerStages: ["pharmacist"],
        salaryMin: 500_000,
        salaryMax: null,
      },
    });
  });

  it("drops a period given for a non-temporary job", () => {
    const parsed = parseJob(
      { ...valid, startDate: "2026-11-01", endDate: "2026-12-01" },
      NOW,
    );
    expect(parsed.ok && [parsed.data.startDate, parsed.data.endDate]).toEqual([
      null,
      null,
    ]);
  });

  it.each([
    [{ title: "صيد" }, { title: "tooShort" }],
    [{ category: "doctor" }, { category: "invalidChoice" }],
    [{ employmentType: "" }, { employmentType: "required" }],
    [{ description: "ق".repeat(4001) }, { description: "tooLong" }],
    [{ minYearsExperience: "41" }, { minYearsExperience: "outOfRange" }],
    [{ minYearsExperience: "2.5" }, { minYearsExperience: "invalidNumber" }],
    [
      { careerStages: ["pharmacist", "doctor"] },
      { careerStages: "invalidChoice" },
    ],
    [{ salaryMin: "0" }, { salaryMin: "outOfRange" }],
    [{ salaryMin: "-5" }, { salaryMin: "invalidNumber" }],
    [{ salaryMin: "9000", salaryMax: "8000" }, { salaryMax: "salaryOrder" }],
  ])("refuses %j", (change, fieldErrors) => {
    expect(parseJob({ ...valid, ...change }, NOW)).toEqual({
      ok: false,
      fieldErrors,
    });
  });

  it.each([
    [{}, { startDate: "required", endDate: "required" }],
    [
      { startDate: "2026-02-30", endDate: "2026-12-01" },
      { startDate: "invalidDate" },
    ],
    [
      { startDate: "2026-10-25", endDate: "2026-10-24" },
      { startDate: "inPast", endDate: "endBeforeStart" },
    ],
    [
      { startDate: "2026-11-01", endDate: "2027-12-01" },
      { endDate: "periodTooLong" },
    ],
  ])("checks a temporary period %j", (period, fieldErrors) => {
    expect(
      parseJob({ ...valid, employmentType: "temporary", ...period }, NOW),
    ).toEqual({ ok: false, fieldErrors });
  });

  it("accepts a temporary period starting today in Cairo", () => {
    // 23:30 UTC on the 25th is already the 26th in Cairo.
    const parsed = parseJob(
      {
        ...valid,
        employmentType: "temporary",
        startDate: "2026-10-26",
        endDate: "2026-11-25",
      },
      new Date("2026-10-25T23:30:00Z"),
    );
    expect(parsed.ok).toBe(true);
  });
});

describe("parseDecision", () => {
  it("approval always carries meets_guidelines", () => {
    expect(
      parseDecision({ decision: "approved", reasonCode: "other" }),
    ).toEqual({
      ok: true,
      data: {
        decision: "approved",
        reasonCode: "meets_guidelines",
        note: null,
      },
    });
  });

  it("rejection needs a rejection reason", () => {
    expect(parseDecision({ decision: "rejected" })).toEqual({
      ok: false,
      fieldErrors: { reasonCode: "required" },
    });
    expect(
      parseDecision({ decision: "rejected", reasonCode: "meets_guidelines" }),
    ).toEqual({ ok: false, fieldErrors: { reasonCode: "invalidChoice" } });
    expect(parseDecision({ decision: "maybe" })).toMatchObject({ ok: false });
    expect(
      parseDecision({
        decision: "rejected",
        reasonCode: "other",
        note: "x".repeat(501),
      }),
    ).toEqual({ ok: false, fieldErrors: { note: "tooLong" } });
  });
});

describe("parseSearch", () => {
  it("ignores invalid filters", () => {
    expect(
      parseSearch({
        q: "  صيدلي ",
        governorate: "abc",
        category: "doctor",
        type: "full_time",
        cursor: "<script>",
      }),
    ).toEqual({
      q: "صيدلي",
      governorateId: null,
      category: null,
      employmentType: "full_time",
      cursor: null,
    });
  });
});

describe("normalizeForSearch", () => {
  it("unifies Arabic letter forms, digits and marks", () => {
    expect(normalizeForSearch("أحمد إسلام آمال ٱبن")).toBe(
      "احمد اسلام امال ابن",
    );
    expect(normalizeForSearch("صيدلـــيّة مُستشفى")).toBe("صيدليه مستشفي");
    expect(normalizeForSearch("مسؤول، رئيس؟ ٢٠٢٦")).toBe("مسوول رييس 2026");
    expect(normalizeForSearch("Pharmacy‮ Manager")).toBe("pharmacy manager");
  });
});

describe("transition table", () => {
  it("never leaves a final state and never returns to draft", () => {
    expect(TRANSITIONS.closed).toEqual([]);
    expect(TRANSITIONS.expired).toEqual([]);
    for (const from of JOB_STATUSES)
      expect(canTransition(from, "draft")).toBe(false);
  });
});
