import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { STAFF_ROLES } from "./roles";

// Better Auth tables (ADR-002). Property names are the model fields Better Auth
// reads and writes; column names are snake_case. Generated from Better Auth's
// own Drizzle generator for this configuration (uuid ids, database rate limit,
// two-factor plugin, session.mfaVerifiedAt), then changed to timestamptz and
// tightened to NOT NULL where the library always writes a value. Better Auth
// checks this file against its expected schema at start-up.

const id = () =>
  uuid("id")
    .default(sql`gen_random_uuid()`)
    .primaryKey();

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

export const user = pgTable("user", {
  id: id(),
  // Always empty: Better Auth requires the column, but display names live in
  // the profiles module (ADR-003).
  name: text("name").notNull(),
  // Stored lowercased by Better Auth.
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  twoFactorEnabled: boolean("two_factor_enabled").default(false).notNull(),
  createdAt: timestamptz("created_at").defaultNow().notNull(),
  updatedAt: timestamptz("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = pgTable(
  "session",
  {
    id: id(),
    // The cookie value; unique lookup key. Revoking a session deletes the row.
    token: text("token").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamptz("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    // Set only when this session was created by a TOTP or backup-code check
    // (see auth-config.ts). Staff access requires it.
    mfaVerifiedAt: timestamptz("mfa_verified_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: id(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamptz("access_token_expires_at"),
    refreshTokenExpiresAt: timestamptz("refresh_token_expires_at"),
    scope: text("scope"),
    // Password hash (scrypt, Better Auth default) for the "credential" provider.
    password: text("password"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

// Short-lived values: password-reset tokens, pending 2FA challenges.
export const verification = pgTable(
  "verification",
  {
    id: id(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const twoFactor = pgTable(
  "two_factor",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Encrypted with BETTER_AUTH_SECRET by Better Auth.
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: boolean("verified").default(true).notNull(),
    failedVerificationCount: integer("failed_verification_count")
      .default(0)
      .notNull(),
    lockedUntil: timestamptz("locked_until"),
  },
  // One TOTP record per user; Better Auth updates it in place on re-enrolment.
  // (Better Auth also declares an index on the encrypted secret; it is never
  // queried by value, so it is left out.)
  (table) => [unique("two_factor_user_id_key").on(table.userId)],
);

// Rate-limit counters. Better Auth keys rows "ip|path"; the per-email limiter
// (rate-limit.ts) keys them "email|path|<keyed hash>". No raw emails are stored.
export const rateLimit = pgTable("rate_limit", {
  id: id(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  // Epoch milliseconds, as Better Auth expects.
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

// Staff duty roles (ADR-002). Regular users have no row. Granted only by the
// operator CLI until the audited admin UI (step 7).
export const userRole = pgTable(
  "user_role",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: STAFF_ROLES }).notNull(),
    // NULL when granted by the operator CLI or when the granting user was deleted.
    grantedBy: uuid("granted_by").references(() => user.id, {
      onDelete: "set null",
    }),
    grantedAt: timestamptz("granted_at").defaultNow().notNull(),
  },
  (table) => [
    unique("user_role_user_id_role_key").on(table.userId, table.role),
    index("user_role_granted_by_idx").on(table.grantedBy),
    check(
      "user_role_role_check",
      sql.raw(
        `${table.role.name} in (${STAFF_ROLES.map((r) => `'${r}'`).join(", ")})`,
      ),
    ),
  ],
);

/** The tables Better Auth's Drizzle adapter reads and writes, by model name. */
export const authSchema = {
  user,
  session,
  account,
  verification,
  twoFactor,
  rateLimit,
};
