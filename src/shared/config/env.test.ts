import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";

const valid = {
  DATABASE_URL: "postgres://u:SECRET-PASS@localhost:5432/db",
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "us-east-1",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "SECRET-VALUE",
  S3_PRIVATE_BUCKET: "private",
  S3_PUBLIC_BUCKET: "public",
  SMTP_HOST: "localhost",
  SMTP_PORT: "1025",
  APP_URL: "http://localhost:3000",
};

describe("parseEnv", () => {
  it("parses a valid environment and coerces the port", () => {
    const env = parseEnv(valid);
    expect(env.SMTP_PORT).toBe(1025);
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("lists missing keys without printing values", () => {
    const { S3_SECRET_ACCESS_KEY: _omitted, ...rest } = valid;
    void _omitted;
    expect(() => parseEnv({ ...rest, SMTP_PORT: "not-a-number" })).toThrowError(
      /S3_SECRET_ACCESS_KEY, SMTP_PORT/,
    );
    try {
      parseEnv({ ...rest, SMTP_PORT: "not-a-number" });
    } catch (error) {
      const message = String(error);
      expect(message).not.toContain("SECRET-PASS");
      expect(message).not.toContain("not-a-number");
    }
  });
});
