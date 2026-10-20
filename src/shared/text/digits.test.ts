import { describe, expect, it } from "vitest";
import { toWesternDigits } from "./digits";

describe("toWesternDigits", () => {
  it("converts Eastern Arabic digits", () => {
    expect(toWesternDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
  });
  it("converts Persian digits", () => {
    expect(toWesternDigits("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
  });
  it("handles mixed digit systems and leaves other characters alone", () => {
    expect(toWesternDigits("رقم ٠١0۲ abc-٣")).toBe("رقم 0102 abc-3");
  });
  it("returns empty and Western-only strings unchanged", () => {
    expect(toWesternDigits("")).toBe("");
    expect(toWesternDigits("0123")).toBe("0123");
  });
});
