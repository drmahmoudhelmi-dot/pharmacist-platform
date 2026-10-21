import {
  createKeyring,
  decryptField,
  encryptField,
  type Encrypted,
  KeyConfigError,
  type Keyring,
  keyedHash,
  parseKey,
  sameKey,
} from "@/shared/crypto/field-encryption";

// National ID protection (ADR-004, 4b): AES-256-GCM with a key held outside the
// database, plus an HMAC-SHA256 under a separate key for the uniqueness check.
// Keys come from the environment (the host's secret store in production):
//
//   NATIONAL_ID_ENCRYPTION_KEY            32 bytes, base64. Encrypts new values.
//   NATIONAL_ID_ENCRYPTION_PREVIOUS_KEYS  optional, comma-separated: older keys
//                                         that still decrypt stored values
//                                         during a rotation.
//   NATIONAL_ID_HASH_KEY                  32 bytes, base64, different from the
//                                         encryption key. Must never change
//                                         without re-hashing every row (the
//                                         uniqueness check depends on it).
//
// They are not part of the general env schema on purpose: only code that
// handles national IDs loads them, and it fails right there with the variable
// name (never the value) when one is missing or malformed. The worker never
// needs them.

export type NationalIdKeys = {
  encryption: Keyring;
  hashKey: Buffer;
};

type Source = Record<string, string | undefined>;

const isPlaceholder = (key: Buffer) => key.every((byte) => byte === key[0]);

function isLocalApp(appUrl: string | undefined): boolean {
  try {
    const host = new URL(appUrl ?? "").hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

export function loadNationalIdKeys(source: Source): NationalIdKeys {
  const current = parseKey(
    source.NATIONAL_ID_ENCRYPTION_KEY,
    "NATIONAL_ID_ENCRYPTION_KEY",
  );
  const previous = (source.NATIONAL_ID_ENCRYPTION_PREVIOUS_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((value, i) =>
      parseKey(value, `NATIONAL_ID_ENCRYPTION_PREVIOUS_KEYS[${i}]`),
    );
  const hashKey = parseKey(source.NATIONAL_ID_HASH_KEY, "NATIONAL_ID_HASH_KEY");
  if (sameKey(current, hashKey) || previous.some((k) => sameKey(k, hashKey)))
    throw new KeyConfigError(
      "NATIONAL_ID_HASH_KEY must differ from the encryption keys",
    );
  // The .env.example placeholders repeat one byte. Refuse such keys unless the
  // app runs on localhost, so a copied example file cannot reach a real host.
  if (!isLocalApp(source.APP_URL)) {
    if (isPlaceholder(current))
      throw new KeyConfigError(
        "NATIONAL_ID_ENCRYPTION_KEY is a local placeholder",
      );
    if (isPlaceholder(hashKey))
      throw new KeyConfigError("NATIONAL_ID_HASH_KEY is a local placeholder");
  }
  return { encryption: createKeyring(current, previous), hashKey };
}

let cached: NationalIdKeys | undefined;

/** The process's keys, loaded on first use. Throws KeyConfigError if unusable. */
export function getNationalIdKeys(): NationalIdKeys {
  cached ??= loadNationalIdKeys(process.env);
  return cached;
}

// The context binds a ciphertext to its owner: copied into another user's row
// it no longer decrypts.
const context = (userId: string) =>
  `verification_submission.national_id:${userId}`;
const HASH_DOMAIN = "national_id/v1";

export function encryptNationalId(
  keys: NationalIdKeys,
  userId: string,
  nationalId: string,
): Encrypted {
  return encryptField(keys.encryption, nationalId, context(userId));
}

export function decryptNationalId(
  keys: NationalIdKeys,
  userId: string,
  ciphertext: string,
): string {
  return decryptField(keys.encryption, ciphertext, context(userId));
}

/** Same national ID → same hash, for every user; without the key, meaningless. */
export function hashNationalId(
  keys: NationalIdKeys,
  nationalId: string,
): string {
  return keyedHash(keys.hashKey, HASH_DOMAIN, nationalId);
}
