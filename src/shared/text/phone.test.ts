import { describe, expect, it } from "vitest";
import { normalizeEgyptianMobile } from "./phone";

const ok = (e164: string) => ({ ok: true, e164 });
const err = (error: string) => ({ ok: false, error });

describe("normalizeEgyptianMobile", () => {
  it.each([
    ["01012345678", "+201012345678"],
    ["01112345678", "+201112345678"],
    ["01212345678", "+201212345678"],
    ["01512345678", "+201512345678"],
    ["+201012345678", "+201012345678"],
    ["00201012345678", "+201012345678"],
    ["010 1234 5678", "+201012345678"],
    ["010-1234-5678", "+201012345678"],
    ["+20 10 1234 5678", "+201012345678"],
    ["+20 (10) 1234-5678", "+201012345678"],
    ["  01012345678  ", "+201012345678"],
  ])("accepts %s", (input, e164) => {
    expect(normalizeEgyptianMobile(input)).toEqual(ok(e164));
  });

  it("accepts Eastern Arabic and Persian digits", () => {
    expect(normalizeEgyptianMobile("٠١٠١٢٣٤٥٦٧٨")).toEqual(ok("+201012345678"));
    expect(normalizeEgyptianMobile("۰۱۱۱۲۳۴۵۶۷۸")).toEqual(ok("+201112345678"));
    expect(normalizeEgyptianMobile("+٢٠١٢١٢٣٤٥٦٧٨")).toEqual(
      ok("+201212345678"),
    );
  });

  it("accepts mixed digit systems", () => {
    expect(normalizeEgyptianMobile("٠1٠ 1۲34-5٦78")).toEqual(
      ok("+201012345678"),
    );
  });

  it.each([
    "01312345678",
    "01412345678",
    "01612345678",
    "01912345678",
    "01012345678".replace("010", "017"),
  ])("rejects invalid prefix %s", (input) => {
    expect(normalizeEgyptianMobile(input)).toEqual(err("invalid_prefix"));
  });

  it("rejects landlines and foreign numbers as invalid prefix", () => {
    expect(normalizeEgyptianMobile("02212345678")).toEqual(
      err("invalid_prefix"),
    );
    expect(normalizeEgyptianMobile("+966501234567")).toEqual(
      err("invalid_prefix"),
    );
    expect(normalizeEgyptianMobile("1012345678")).toEqual(
      err("invalid_prefix"),
    );
  });

  it.each([
    "0101234567",
    "010123456789",
    "+20101234567",
    "+2010123456789",
    "002010123456",
  ])("rejects wrong length %s", (input) => {
    expect(normalizeEgyptianMobile(input)).toEqual(err("invalid_length"));
  });

  it("rejects letters and misplaced plus signs", () => {
    expect(normalizeEgyptianMobile("0101234abcd")).toEqual(
      err("invalid_characters"),
    );
    expect(normalizeEgyptianMobile("010+12345678")).toEqual(
      err("invalid_characters"),
    );
    expect(normalizeEgyptianMobile("++201012345678")).toEqual(
      err("invalid_characters"),
    );
  });

  it("rejects empty input", () => {
    expect(normalizeEgyptianMobile("")).toEqual(err("empty"));
    expect(normalizeEgyptianMobile("   ")).toEqual(err("empty"));
  });
});
