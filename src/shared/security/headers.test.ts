import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, createNonce } from "./headers";

describe("buildContentSecurityPolicy", () => {
  it("has no unsafe-eval or unsafe-inline outside development", () => {
    const csp = buildContentSecurityPolicy("abc", false);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it("allows eval only in development", () => {
    expect(buildContentSecurityPolicy("abc", true)).toContain("'unsafe-eval'");
  });
});

describe("createNonce", () => {
  it("returns distinct base64 values", () => {
    const a = createNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(createNonce()).not.toBe(a);
  });
});
