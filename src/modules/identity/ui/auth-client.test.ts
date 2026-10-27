import { describe, expect, it } from "vitest";
import { toErrorKey } from "./auth-client";

describe("toErrorKey", () => {
  it("maps library codes to message keys", () => {
    expect(toErrorKey(401, "INVALID_EMAIL_OR_PASSWORD")).toBe(
      "invalidCredentials",
    );
    expect(toErrorKey(403, "EMAIL_NOT_VERIFIED")).toBe("emailNotVerified");
    expect(toErrorKey(403, "ACCOUNT_SUSPENDED")).toBe("accountSuspended");
    expect(toErrorKey(400, "TOKEN_EXPIRED")).toBe("invalidToken");
    expect(toErrorKey(400, "PASSWORD_COMPROMISED")).toBe("passwordCompromised");
  });

  it("treats any 429 as rate limited", () => {
    expect(toErrorKey(429, undefined)).toBe("rateLimited");
    expect(toErrorKey(429, "SOMETHING")).toBe("rateLimited");
  });

  it("falls back for unknown codes and never uses inherited keys", () => {
    expect(toErrorKey(500, "NOT_A_CODE")).toBe("generic");
    expect(toErrorKey(400, "toString")).toBe("generic");
    expect(toErrorKey(401, undefined)).toBe("unauthenticated");
  });
});
