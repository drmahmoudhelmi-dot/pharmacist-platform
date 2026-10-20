import { describe, expect, it } from "vitest";
import { normalizeName } from "./name";

describe("normalizeName", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeName("  أحمد   محمد \t علي\n")).toBe("أحمد محمد علي");
  });
  it("removes tatweel", () => {
    expect(normalizeName("محمـــد")).toBe("محمد");
  });
  it("keeps mixed Arabic and Latin names", () => {
    expect(normalizeName("  Ahmed   أحمد  ")).toBe("Ahmed أحمد");
  });
  it("returns empty for whitespace-only input", () => {
    expect(normalizeName("   ")).toBe("");
  });
});
