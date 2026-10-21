import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createKeyring,
  DecryptionError,
  decryptField,
  encryptField,
  KeyConfigError,
  keyedHash,
  keyIdOf,
  keyIdOfCiphertext,
  parseKey,
} from "./field-encryption";

// Keys are generated per run: no key-shaped literal lives in the repository.
const key = () => randomBytes(32);

describe("parseKey", () => {
  it("accepts 32 bytes in base64 or base64url", () => {
    const raw = key();
    expect(parseKey(raw.toString("base64"), "K").equals(raw)).toBe(true);
    expect(parseKey(raw.toString("base64url"), "K").equals(raw)).toBe(true);
  });

  it("refuses missing, malformed and wrong-length keys, naming only the variable", () => {
    const secret = key().subarray(0, 16).toString("base64");
    for (const [value, message] of [
      [undefined, "K is not set"],
      ["  ", "K is not set"],
      ["not base64!", "K is not base64"],
      [secret, "K must decode to 32 bytes"],
      [randomBytes(33).toString("base64"), "K must decode to 32 bytes"],
    ] as const) {
      expect(() => parseKey(value, "K")).toThrow(KeyConfigError);
      expect(() => parseKey(value, "K")).toThrow(message);
    }
    try {
      parseKey(secret, "K");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe("encryptField / decryptField", () => {
  const ring = createKeyring(key());

  it("round-trips and uses a fresh IV every time", () => {
    const a = encryptField(ring, "29001011234567", "ctx");
    const b = encryptField(ring, "29001011234567", "ctx");
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.ciphertext).not.toContain("29001011234567");
    expect(a.ciphertext).toMatch(
      /^v1\.[0-9a-f]{16}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/,
    );
    expect(a.keyId).toBe(ring.current.id);
    expect(keyIdOfCiphertext(a.ciphertext)).toBe(a.keyId);
    expect(decryptField(ring, a.ciphertext, "ctx")).toBe("29001011234567");
    expect(decryptField(ring, b.ciphertext, "ctx")).toBe("29001011234567");
  });

  it("fails with a wrong key, a wrong context, or any tampering", () => {
    const { ciphertext } = encryptField(ring, "29001011234567", "user-a");
    expect(() =>
      decryptField(createKeyring(key()), ciphertext, "user-a"),
    ).toThrow(DecryptionError);
    expect(() => decryptField(ring, ciphertext, "user-b")).toThrow(
      DecryptionError,
    );
    const parts = ciphertext.split(".");
    for (const index of [2, 3, 4]) {
      const tampered = [...parts];
      const bytes = Buffer.from(tampered[index]!, "base64url");
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      tampered[index] = bytes.toString("base64url");
      expect(() => decryptField(ring, tampered.join("."), "user-a")).toThrow(
        DecryptionError,
      );
    }
    for (const broken of [
      "",
      "v2" + ciphertext.slice(2),
      parts.slice(0, 4).join("."),
      ciphertext + ".x",
    ])
      expect(() => decryptField(ring, broken, "user-a")).toThrow(
        DecryptionError,
      );
  });

  it("decrypts values of a previous key after rotation; new values use the new key", () => {
    const oldKey = key();
    const before = encryptField(createKeyring(oldKey), "secret", "c");
    const rotated = createKeyring(key(), [oldKey]);
    expect(decryptField(rotated, before.ciphertext, "c")).toBe("secret");
    const after = encryptField(rotated, "secret", "c");
    expect(after.keyId).not.toBe(before.keyId);
    expect(after.keyId).toBe(rotated.current.id);
    // Dropping the old key makes old values unreadable.
    expect(() =>
      decryptField(createKeyring(rotated.current.key), before.ciphertext, "c"),
    ).toThrow(DecryptionError);
  });

  it("derives stable, distinct key ids", () => {
    const k = key();
    expect(keyIdOf(k)).toBe(keyIdOf(Buffer.from(k)));
    expect(keyIdOf(k)).toMatch(/^[0-9a-f]{16}$/);
    expect(keyIdOf(k)).not.toBe(keyIdOf(key()));
  });
});

describe("keyedHash", () => {
  it("is deterministic per key and domain, and separates keys and domains", () => {
    const k1 = key();
    const k2 = key();
    const h = keyedHash(k1, "national_id/v1", "29001011234567");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(keyedHash(k1, "national_id/v1", "29001011234567")).toBe(h);
    expect(keyedHash(k2, "national_id/v1", "29001011234567")).not.toBe(h);
    expect(keyedHash(k1, "other/v1", "29001011234567")).not.toBe(h);
    expect(keyedHash(k1, "national_id/v1", "29001011234568")).not.toBe(h);
    expect(h).not.toContain("29001011234567");
  });
});
