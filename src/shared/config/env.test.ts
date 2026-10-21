import { describe, expect, it } from "vitest";
import { parseEnv, parseWorkerEnv } from "./env";

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
  BETTER_AUTH_SECRET: "test-only-secret-0123456789abcdef0123456789",
  EMAIL_FROM: "no-reply@example.test",
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

  it("rejects an auth secret shorter than 32 characters without echoing it", () => {
    const short = "too-short-SECRET";
    expect(() =>
      parseEnv({ ...valid, BETTER_AUTH_SECRET: short }),
    ).toThrowError(/BETTER_AUTH_SECRET/);
    try {
      parseEnv({ ...valid, BETTER_AUTH_SECRET: short });
    } catch (error) {
      expect(String(error)).not.toContain(short);
    }
  });

  it("requires EMAIL_FROM", () => {
    const { EMAIL_FROM: _omitted, ...rest } = valid;
    void _omitted;
    expect(() => parseEnv(rest)).toThrowError(/EMAIL_FROM/);
  });

  it("turns the breached-password check on by default", () => {
    expect(parseEnv(valid).AUTH_BREACHED_PASSWORD_CHECK).toBe(true);
  });

  it('parses "false" as false and rejects other values', () => {
    expect(
      parseEnv({ ...valid, AUTH_BREACHED_PASSWORD_CHECK: "false" })
        .AUTH_BREACHED_PASSWORD_CHECK,
    ).toBe(false);
    expect(() =>
      parseEnv({ ...valid, AUTH_BREACHED_PASSWORD_CHECK: "no" }),
    ).toThrowError(/AUTH_BREACHED_PASSWORD_CHECK/);
  });
});

describe("parseWorkerEnv", () => {
  it("requires the clamd address on top of the app variables", () => {
    expect(() => parseWorkerEnv(valid)).toThrowError(
      /CLAMAV_HOST, CLAMAV_PORT/,
    );
    const env = parseWorkerEnv({
      ...valid,
      CLAMAV_HOST: "clamav",
      CLAMAV_PORT: "3310",
    });
    expect(env.CLAMAV_PORT).toBe(3310);
    expect(env.DATABASE_URL).toBe(valid.DATABASE_URL);
  });

  it("does not require clamd for the web app", () => {
    expect(() => parseEnv(valid)).not.toThrow();
  });
});
