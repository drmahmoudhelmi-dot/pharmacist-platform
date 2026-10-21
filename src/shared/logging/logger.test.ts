import { describe, expect, it } from "vitest";
import { createLogger } from "./logger";

function capture() {
  const lines: string[] = [];
  const logger = createLogger(
    { level: "info" },
    { write: (chunk: string) => void lines.push(chunk) },
  );
  return { logger, lines };
}

describe("logger redaction", () => {
  it("redacts sensitive keys at top level and nested", () => {
    const { logger, lines } = capture();
    logger.info(
      {
        password: "hunter2",
        token: "tok-123",
        otp: "654321",
        nationalId: "29001010123456",
        legalNameAr: "اسم قانوني للاختبار",
        email: "test.user@example.test",
        user: {
          password: "nested-pass",
          nationalId: "29001010123456",
          phone: "+201000000000",
          legalName: "اسم آخر للاختبار",
        },
      },
      "event",
    );
    const out = lines.join("");
    for (const secret of [
      "hunter2",
      "tok-123",
      "654321",
      "29001010123456",
      "nested-pass",
      "test.user@example.test",
      "+201000000000",
      "اسم قانوني للاختبار",
      "اسم آخر للاختبار",
    ]) {
      expect(out).not.toContain(secret);
    }
    const parsed = JSON.parse(out);
    expect(parsed.password).toBe("[redacted]");
    expect(parsed.user.nationalId).toBe("[redacted]");
    expect(parsed.legalNameAr).toBe("[redacted]");
    expect(parsed.user.legalName).toBe("[redacted]");
    expect(parsed.msg).toBe("event");
  });

  it("redacts authorization and cookie headers", () => {
    const { logger, lines } = capture();
    logger.info({
      req: {
        headers: {
          authorization: "Bearer abc",
          cookie: "sid=xyz",
          accept: "*/*",
        },
      },
    });
    const out = lines.join("");
    expect(out).not.toContain("Bearer abc");
    expect(out).not.toContain("sid=xyz");
    expect(JSON.parse(out).req.headers.accept).toBe("*/*");
  });
});
