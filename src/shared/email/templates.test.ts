import { describe, expect, it } from "vitest";
import { renderAuthEmail, toEmailLocale } from "./templates";

const url = "https://app.example/verify-email?token=abc.def-ghi&x=<y>";

describe("renderAuthEmail", () => {
  it("renders Arabic RTL by default with the link in both bodies", () => {
    const msg = renderAuthEmail("verification", {
      to: "a@example.test",
      url,
      locale: "ar",
    });
    expect(msg.language).toBe("ar");
    expect(msg.subject).toContain("تأكيد");
    expect(msg.html).toContain('lang="ar" dir="rtl"');
    expect(msg.text).toContain(url);
    // HTML-escaped so a crafted URL cannot inject markup.
    expect(msg.html).toContain("x=&lt;y&gt;");
    expect(msg.html).not.toContain("<y>");
  });

  it("renders English LTR when the locale is en", () => {
    const msg = renderAuthEmail("passwordReset", {
      to: "a@example.test",
      url,
      locale: "en",
    });
    expect(msg.subject).toBe("Reset your password - Pharmacist Platform");
    expect(msg.html).toContain('lang="en" dir="ltr"');
  });

  it("has a template for each auth email", () => {
    for (const kind of [
      "verification",
      "passwordReset",
      "accountExists",
    ] as const) {
      for (const locale of ["ar", "en"] as const) {
        const msg = renderAuthEmail(kind, {
          to: "a@example.test",
          url,
          locale,
        });
        expect(msg.subject.length).toBeGreaterThan(5);
        expect(msg.text).toContain(url);
      }
    }
  });
});

describe("toEmailLocale", () => {
  it("falls back to Arabic for anything but en", () => {
    expect(toEmailLocale("en")).toBe("en");
    expect(toEmailLocale("fr")).toBe("ar");
    expect(toEmailLocale(null)).toBe("ar");
    expect(toEmailLocale(undefined)).toBe("ar");
  });
});
