import { describe, expect, it } from "vitest";
import { checkEmail, checkPassword, normalizeCode } from "./validation";

describe("checkPassword", () => {
  it("requires 10 to 128 characters and no composition rules", () => {
    expect(checkPassword("")).toBe("required");
    expect(checkPassword("a".repeat(9))).toBe("passwordLength");
    expect(checkPassword("a".repeat(10))).toBeNull();
    expect(checkPassword("كلمة سر طويلة")).toBeNull();
    expect(checkPassword("a".repeat(128))).toBeNull();
    expect(checkPassword("a".repeat(129))).toBe("passwordLength");
  });
});

describe("checkEmail", () => {
  it("accepts ordinary addresses including Gmail", () => {
    expect(checkEmail("someone@gmail.com")).toBeNull();
    expect(checkEmail("  someone@example.co.eg ")).toBeNull();
  });
  it("rejects empty and malformed input", () => {
    expect(checkEmail(" ")).toBe("required");
    expect(checkEmail("not-an-email")).toBe("invalidEmail");
  });
});

describe("normalizeCode", () => {
  it("converts Arabic-Indic digits and strips spaces", () => {
    expect(normalizeCode("١٢٣ ٤٥٦")).toBe("123456");
    expect(normalizeCode("12-34-56")).toBe("123456");
  });
});
