import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptNationalId,
  encryptNationalId,
  hashNationalId,
  loadNationalIdKeys,
} from "./keys";

const b64 = () => randomBytes(32).toString("base64");

describe("loadNationalIdKeys", () => {
  it("fails fast, naming the missing or bad variable", () => {
    expect(() => loadNationalIdKeys({})).toThrow(
      "NATIONAL_ID_ENCRYPTION_KEY is not set",
    );
    expect(() =>
      loadNationalIdKeys({ NATIONAL_ID_ENCRYPTION_KEY: b64() }),
    ).toThrow("NATIONAL_ID_HASH_KEY is not set");
    expect(() =>
      loadNationalIdKeys({
        NATIONAL_ID_ENCRYPTION_KEY: b64(),
        NATIONAL_ID_HASH_KEY: "short",
      }),
    ).toThrow("NATIONAL_ID_HASH_KEY must decode to 32 bytes");
    expect(() =>
      loadNationalIdKeys({
        NATIONAL_ID_ENCRYPTION_KEY: b64(),
        NATIONAL_ID_ENCRYPTION_PREVIOUS_KEYS: "nope",
        NATIONAL_ID_HASH_KEY: b64(),
      }),
    ).toThrow("NATIONAL_ID_ENCRYPTION_PREVIOUS_KEYS[0]");
  });

  it("refuses the same key for encryption and hashing", () => {
    const same = b64();
    expect(() =>
      loadNationalIdKeys({
        NATIONAL_ID_ENCRYPTION_KEY: same,
        NATIONAL_ID_HASH_KEY: same,
      }),
    ).toThrow("must differ");
  });

  it("accepts the repeated-byte placeholders only for a localhost app", () => {
    const placeholder = {
      NATIONAL_ID_ENCRYPTION_KEY: Buffer.alloc(32, 0x11).toString("base64"),
      NATIONAL_ID_HASH_KEY: Buffer.alloc(32, 0x22).toString("base64"),
    };
    expect(() =>
      loadNationalIdKeys({ ...placeholder, APP_URL: "http://localhost:3000" }),
    ).not.toThrow();
    for (const APP_URL of ["https://app.example", undefined])
      expect(() => loadNationalIdKeys({ ...placeholder, APP_URL })).toThrow(
        "local placeholder",
      );
    expect(() =>
      loadNationalIdKeys({
        NATIONAL_ID_ENCRYPTION_KEY: b64(),
        NATIONAL_ID_HASH_KEY: placeholder.NATIONAL_ID_HASH_KEY,
        APP_URL: "https://app.example",
      }),
    ).toThrow("NATIONAL_ID_HASH_KEY is a local placeholder");
  });

  it("binds ciphertext to its owner and hashes independently of the owner", () => {
    const keys = loadNationalIdKeys({
      NATIONAL_ID_ENCRYPTION_KEY: b64(),
      NATIONAL_ID_HASH_KEY: b64(),
    });
    const { ciphertext } = encryptNationalId(keys, "user-a", "29003150112345");
    expect(decryptNationalId(keys, "user-a", ciphertext)).toBe(
      "29003150112345",
    );
    expect(() => decryptNationalId(keys, "user-b", ciphertext)).toThrow();
    expect(hashNationalId(keys, "29003150112345")).toBe(
      hashNationalId(keys, "29003150112345"),
    );
    const otherHashKey = loadNationalIdKeys({
      NATIONAL_ID_ENCRYPTION_KEY: b64(),
      NATIONAL_ID_HASH_KEY: b64(),
    });
    expect(hashNationalId(otherHashKey, "29003150112345")).not.toBe(
      hashNationalId(keys, "29003150112345"),
    );
  });
});
