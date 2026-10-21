import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// Field-level encryption and keyed hashing for the most sensitive columns
// (ADR-004, 4b: the national ID number). Node's built-in crypto only: AES-256-GCM
// for confidentiality and integrity, HMAC-SHA256 for deterministic lookups. No
// custom primitives. Keys live outside the database (environment / secret
// store) and are never logged.
//
// Ciphertext format, version 1 (ASCII, safe for a text column):
//   v1.<keyId>.<iv>.<ciphertext>.<tag>
// with iv (12 random bytes), ciphertext and tag (16 bytes) in base64url. The
// key id names the key that encrypted the value, so keys can be rotated: new
// writes use the current key, older values stay readable while their key is
// still in the keyring, and a re-encryption job can move them forward. The
// caller's context string is bound as additional authenticated data, so a
// ciphertext copied into another row (another user's) fails to decrypt.

export const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = "v1";

/** Thrown for malformed keys. Messages name the problem, never the value. */
export class KeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyConfigError";
  }
}

/** Thrown when a value cannot be decrypted. Carries no detail on purpose. */
export class DecryptionError extends Error {
  constructor() {
    super("decryption failed");
    this.name = "DecryptionError";
  }
}

/**
 * Decodes a base64 (or base64url) key of exactly 32 bytes. `name` is used in
 * the error message (the variable name), the value never is.
 */
export function parseKey(value: string | undefined, name: string): Buffer {
  const text = value?.trim() ?? "";
  if (text === "") throw new KeyConfigError(`${name} is not set`);
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text))
    throw new KeyConfigError(`${name} is not base64`);
  const key = Buffer.from(
    text,
    text.includes("-") || text.includes("_") ? "base64url" : "base64",
  );
  if (key.length !== KEY_BYTES)
    throw new KeyConfigError(`${name} must decode to ${KEY_BYTES} bytes`);
  return key;
}

/**
 * A short, stable identifier for a key: the first 16 hex characters of a
 * domain-separated SHA-256 of the key. Reveals nothing usable about a random
 * 256-bit key, and lets rotation tell keys apart without naming them by hand.
 */
export function keyIdOf(key: Buffer): string {
  return createHash("sha256")
    .update("pharmacist-platform/key-id/v1\0")
    .update(key)
    .digest("hex")
    .slice(0, 16);
}

export type Keyring = {
  /** Encrypts new values. */
  current: { id: string; key: Buffer };
  /** Every key that may still decrypt stored values, by id (includes current). */
  byId: ReadonlyMap<string, Buffer>;
};

export function createKeyring(
  current: Buffer,
  previous: Buffer[] = [],
): Keyring {
  const byId = new Map<string, Buffer>();
  for (const key of [current, ...previous]) byId.set(keyIdOf(key), key);
  return { current: { id: keyIdOf(current), key: current }, byId };
}

export type Encrypted = { ciphertext: string; keyId: string };

export function encryptField(
  keyring: Keyring,
  plaintext: string,
  context: string,
): Encrypted {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyring.current.key, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const keyId = keyring.current.id;
  return {
    ciphertext: [
      FORMAT_VERSION,
      keyId,
      iv.toString("base64url"),
      body.toString("base64url"),
      tag.toString("base64url"),
    ].join("."),
    keyId,
  };
}

/** The key id a stored value was encrypted with, or null if malformed. */
export function keyIdOfCiphertext(ciphertext: string): string | null {
  const parts = ciphertext.split(".");
  return parts.length === 5 && parts[0] === FORMAT_VERSION
    ? (parts[1] ?? null)
    : null;
}

/**
 * Decrypts a value written by `encryptField` with the same context. Any
 * problem (unknown version or key, wrong context, tampering) throws a
 * DecryptionError without detail.
 */
export function decryptField(
  keyring: Keyring,
  ciphertext: string,
  context: string,
): string {
  const parts = ciphertext.split(".");
  if (parts.length !== 5 || parts[0] !== FORMAT_VERSION)
    throw new DecryptionError();
  const [, keyId, ivText, bodyText, tagText] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const key = keyring.byId.get(keyId);
  if (!key) throw new DecryptionError();
  const iv = Buffer.from(ivText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
    throw new DecryptionError();
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(bodyText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new DecryptionError();
  }
}

/**
 * Deterministic keyed hash (HMAC-SHA256, hex) for uniqueness lookups. The
 * domain string separates uses, so the same input hashed for two purposes
 * gives unrelated values. Without the key the hash cannot be brute-forced
 * from the small national ID space.
 */
export function keyedHash(key: Buffer, domain: string, value: string): string {
  return createHmac("sha256", key)
    .update(domain)
    .update("\0")
    .update(value)
    .digest("hex");
}

/** Constant-time comparison of two keys (used to refuse identical keys). */
export function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
