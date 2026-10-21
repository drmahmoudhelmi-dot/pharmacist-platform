import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, createNonce, originOf } from "./headers";

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

describe("image origins", () => {
  it("adds only the given origins to img-src", () => {
    const csp = buildContentSecurityPolicy("abc", false, [
      "https://storage.example",
    ]);
    expect(csp).toContain(
      "img-src 'self' blob: data: https://storage.example;",
    );
    expect(buildContentSecurityPolicy("abc", false)).toContain(
      "img-src 'self' blob: data:;",
    );
  });

  it("takes the origin of http(s) URLs only", () => {
    expect(originOf("http://localhost:9000")).toBe("http://localhost:9000");
    expect(originOf("https://s3.example/bucket?x=1")).toBe(
      "https://s3.example",
    );
    expect(originOf("javascript:alert(1)")).toBeNull();
    expect(originOf("not a url")).toBeNull();
    expect(originOf(undefined)).toBeNull();
  });
});

describe("createNonce", () => {
  it("returns distinct base64 values", () => {
    const a = createNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(createNonce()).not.toBe(a);
  });
});
