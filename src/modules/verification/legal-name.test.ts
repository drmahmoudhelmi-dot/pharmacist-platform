import { describe, expect, it } from "vitest";
import { LEGAL_NAME_AR_PATTERN } from "./constants";
import { normalizeLegalNameAr, parseLegalNameAr } from "./legal-name";

// Synthetic names only.

describe("normalizeLegalNameAr", () => {
  it("trims, collapses whitespace and removes tatweel", () => {
    expect(normalizeLegalNameAr("  محمـــد   أحمد \t علي\n حسن ")).toBe(
      "محمد أحمد علي حسن",
    );
  });

  it("strips harakat, shadda, sukun, tanween and superscript alef", () => {
    expect(
      normalizeLegalNameAr(
        "م\u064Fح\u064Eم\u064E\u0651د\u064C ع\u064Eب\u0652د\u064F الر\u064E\u0651ح\u0652م\u0670ن\u0650",
      ),
    ).toBe("محمد عبد الرحمن");
  });

  it("keeps hamza forms, alef variants, taa marbuta and alef maqsura as written", () => {
    expect(
      normalizeLegalNameAr("أسامة إبراهيم آمنة مؤمن هانئ مصطفى ٱلسيد"),
    ).toBe("أسامة إبراهيم آمنة مؤمن هانئ مصطفى ٱلسيد");
  });

  it("composes a combining hamza or maddah with its letter", () => {
    // ا + U+0654 → أ, ا + U+0655 → إ, ا + U+0653 → آ, و + U+0654 → ؤ.
    expect(
      normalizeLegalNameAr("ا\u0654حمد ا\u0655براهيم ا\u0653دم مو\u0654من"),
    ).toBe("أحمد إبراهيم آدم مؤمن");
  });

  it("turns presentation forms into plain letters and drops invisible marks", () => {
    // ﻻ (lam-alef ligature), ZWNJ, right-to-left mark, Arabic letter mark.
    expect(normalizeLegalNameAr("ع\uFEFBء \u200Fمحمد\u200C \u061Cسيد")).toBe(
      "علاء محمد سيد",
    );
  });

  it("unifies hyphens and apostrophes and removes spaces around a hyphen", () => {
    expect(normalizeLegalNameAr("محمد عبد \u2013 الله أحمد")).toBe(
      "محمد عبد-الله أحمد",
    );
    expect(normalizeLegalNameAr("محمد ع\u2019لي أحمد")).toBe("محمد ع'لي أحمد");
  });
});

describe("parseLegalNameAr", () => {
  it("accepts a four-part name and returns the stored form", () => {
    expect(
      parseLegalNameAr("  م\u064Fح\u064Eم\u064E\u0651د  أحمد  محمـود   حسن "),
    ).toEqual({
      ok: true,
      value: "محمد أحمد محمود حسن",
    });
  });

  it("accepts three words, the minimum, including a compound part", () => {
    expect(parseLegalNameAr("فاطمة عبد الله")).toEqual({
      ok: true,
      value: "فاطمة عبد الله",
    });
    expect(parseLegalNameAr("سارة عبد-الرحمن علي")).toMatchObject({
      ok: true,
    });
  });

  it("requires a value", () => {
    for (const raw of [undefined, null, 42, "", "   ", "\u064Eـ"])
      expect(parseLegalNameAr(raw)).toEqual({ ok: false, error: "required" });
  });

  it("requires at least three words", () => {
    expect(parseLegalNameAr("محمد")).toEqual({
      ok: false,
      error: "nameTooFewWords",
    });
    expect(parseLegalNameAr("محمد أحمد")).toEqual({
      ok: false,
      error: "nameTooFewWords",
    });
    // A hyphenated part counts as one word.
    expect(parseLegalNameAr("محمد عبد-الله")).toEqual({
      ok: false,
      error: "nameTooFewWords",
    });
  });

  it("rejects Latin letters, digits of any script and symbols", () => {
    for (const raw of [
      "Mohamed Ahmed Ali",
      "محمد أحمد Ali",
      "محمد أحمد علي 2",
      "محمد أحمد علي ٢",
      "محمد أحمد علي ۲",
      "محمد أحمد علي!",
      "محمد، أحمد، علي",
      "محمد أحمد علي.",
    ])
      expect(parseLegalNameAr(raw)).toEqual({
        ok: false,
        error: "nameNotArabic",
      });
  });

  it("maps Persian yeh and keheh to the Arabic letters", () => {
    expect(parseLegalNameAr("محمد أحمد علی کامل")).toEqual({
      ok: true,
      value: "محمد أحمد علي كامل",
    });
  });

  it("rejects punctuation that is not between two letters", () => {
    for (const raw of [
      "-محمد أحمد علي",
      "محمد أحمد علي-",
      "محمد أحمد ' علي",
      "محمد أحمد--علي حسن",
      "محمد ''أحمد علي",
    ])
      expect(parseLegalNameAr(raw)).toEqual({ ok: false, error: "nameFormat" });
  });

  it("limits the normalized length to 120 and the raw input to 400", () => {
    const word = "عبدالرحمن"; // 9 letters
    const long = Array.from({ length: 13 }, () => word).join(" "); // 129
    expect(parseLegalNameAr(long)).toEqual({ ok: false, error: "tooLong" });
    const fits = Array.from({ length: 12 }, () => word).join(" "); // 119
    expect(parseLegalNameAr(fits)).toEqual({ ok: true, value: fits });
    // Diacritics do not count toward the stored length...
    const voweled = fits.replace(/ /g, "\u064E ");
    expect(parseLegalNameAr(voweled)).toEqual({ ok: true, value: fits });
    // ...but the raw input is bounded before any work is done.
    expect(parseLegalNameAr(`محمد أحمد علي${" ".repeat(400)}`)).toEqual({
      ok: false,
      error: "tooLong",
    });
  });

  it("only returns values the database CHECK accepts", () => {
    const shape = new RegExp(LEGAL_NAME_AR_PATTERN, "u");
    for (const raw of [
      "م\u064Fح\u064Eم\u064E\u0651د أحمد علي",
      "أسامة إبراهيم آمنة مؤمن",
      "سارة عبد-الرحمن علي",
      "ع\uFEFBء محمد سيد",
    ]) {
      const result = parseLegalNameAr(raw);
      expect(result.ok).toBe(true);
      if (result.ok) expect(shape.test(result.value)).toBe(true);
    }
    expect(shape.test("محمد  أحمد علي")).toBe(false);
    expect(shape.test(" محمد أحمد علي")).toBe(false);
    expect(shape.test("محمـد أحمد علي")).toBe(false);
    expect(shape.test("م\u064Fحمد أحمد علي")).toBe(false);
  });
});
