import { describe, expect, it } from "vitest";
import ar from "../../../messages/ar.json";
import en from "../../../messages/en.json";

function keys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [prefix];
  return Object.entries(value).flatMap(([k, v]) =>
    keys(v, prefix ? `${prefix}.${k}` : k),
  );
}

describe("messages", () => {
  it("Arabic and English define the same keys", () => {
    expect(keys(en).sort()).toEqual(keys(ar).sort());
  });

  it("has no empty strings", () => {
    for (const [name, messages] of Object.entries({ ar, en })) {
      const empty = keys(messages).filter((k) => {
        const value = k
          .split(".")
          .reduce<unknown>(
            (node, part) => (node as Record<string, unknown>)[part],
            messages,
          );
        return typeof value === "string" && value.trim() === "";
      });
      expect(empty, name).toEqual([]);
    }
  });
});
