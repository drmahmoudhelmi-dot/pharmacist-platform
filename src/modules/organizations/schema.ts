import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "@/modules/identity/schema";
import { governorate } from "@/modules/profiles/schema";
import {
  AUDIT_ACTIONS,
  AUDIT_ROLES,
  EMAIL_LOCALES,
  INVITATION_STATUSES,
  LIMITS,
  MEMBER_ROLES,
  ORGANIZATION_KINDS,
} from "./constants";

// Tables owned by the organizations module (ADR-005). References to other
// modules: `user` (members, inviters, audit actors) and profiles' `governorate`
// reference table (integrity only; the list is read through profiles'
// `listGovernorates`). `organization_audit` is append-only, enforced by the
// trigger from migration 0004, attached in migration 0006.

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

const sqlList = (values: readonly string[]) =>
  values.map((v) => `'${v}'`).join(", ");

export const organization = pgTable(
  "organization",
  {
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    kind: text("kind", { enum: ORGANIZATION_KINDS }).notNull(),
    name: text("name").notNull(),
    governorateId: smallint("governorate_id")
      .notNull()
      .references(() => governorate.id, { onDelete: "restrict" }),
    // Business address of the main branch; optional.
    addressLine: text("address_line"),
    // Counts towards the per-user creation limit; kept if the account goes.
    createdBy: uuid("created_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("organization_created_by_idx").on(table.createdBy),
    index("organization_governorate_id_idx").on(table.governorateId),
    check(
      "organization_kind_check",
      sql.raw(`kind in (${sqlList(ORGANIZATION_KINDS)})`),
    ),
    check(
      "organization_name_check",
      sql.raw(
        `char_length(name) between ${LIMITS.name.min} and ${LIMITS.name.max}`,
      ),
    ),
    check(
      "organization_address_line_check",
      sql.raw(
        `char_length(address_line) between 1 and ${LIMITS.addressLine.max}`,
      ),
    ),
  ],
);

export const organizationMember = pgTable(
  "organization_member",
  {
    // Identifies the membership in URLs and forms instead of the user id.
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: MEMBER_ROLES }).notNull(),
    addedBy: uuid("added_by").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    // Also serves lookups by organization.
    unique("organization_member_org_user_key").on(
      table.organizationId,
      table.userId,
    ),
    // "My organizations".
    index("organization_member_user_id_idx").on(table.userId),
    check(
      "organization_member_role_check",
      sql.raw(`role in (${sqlList(MEMBER_ROLES)})`),
    ),
  ],
);

export const organizationInvitation = pgTable(
  "organization_invitation",
  {
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Lowercased, like identity's user.email, so the match is exact.
    email: text("email").notNull(),
    role: text("role", { enum: MEMBER_ROLES }).notNull(),
    status: text("status", { enum: INVITATION_STATUSES })
      .default("pending")
      .notNull(),
    invitedBy: uuid("invited_by").references(() => user.id, {
      onDelete: "set null",
    }),
    // Who accepted, declined or revoked; null for expired.
    closedBy: uuid("closed_by").references(() => user.id, {
      onDelete: "set null",
    }),
    // Language of the invitation email (the inviter's page locale).
    locale: text("locale", { enum: EMAIL_LOCALES }).default("ar").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    closedAt: timestamptz("closed_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    // One open invitation per address and organization.
    uniqueIndex("organization_invitation_one_pending_idx")
      .on(table.organizationId, table.email)
      .where(sql`${table.status} = 'pending'`),
    // "Invitations for me".
    index("organization_invitation_email_pending_idx")
      .on(table.email)
      .where(sql`${table.status} = 'pending'`),
    // The daily invitation limit per organization.
    index("organization_invitation_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    check(
      "organization_invitation_role_check",
      sql.raw(`role in (${sqlList(MEMBER_ROLES)})`),
    ),
    check(
      "organization_invitation_status_check",
      sql.raw(`status in (${sqlList(INVITATION_STATUSES)})`),
    ),
    check(
      "organization_invitation_locale_check",
      sql.raw(`locale in (${sqlList(EMAIL_LOCALES)})`),
    ),
    check(
      "organization_invitation_email_check",
      sql.raw(
        `email = lower(email) and char_length(email) <= ${LIMITS.email.max} and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'`,
      ),
    ),
    // Status and its closing timestamp move together.
    check(
      "organization_invitation_state_check",
      sql`(${table.status} = 'pending' and ${table.closedAt} is null)
       or (${table.status} <> 'pending' and ${table.closedAt} is not null)`,
    ),
    check(
      "organization_invitation_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

// Append-only history of membership and invitation changes (ADR-005).
// member_id and invitation_id carry no foreign key on purpose: the history
// outlives a removed member or a deleted invitation.
export const organizationAudit = pgTable(
  "organization_audit",
  {
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // The only column a cascaded update may change (to NULL).
    actorId: uuid("actor_id").references(() => user.id, {
      onDelete: "set null",
    }),
    action: text("action", { enum: AUDIT_ACTIONS }).notNull(),
    memberId: uuid("member_id"),
    invitationId: uuid("invitation_id"),
    role: text("role", { enum: AUDIT_ROLES }),
    previousRole: text("previous_role", { enum: AUDIT_ROLES }),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("organization_audit_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
    check(
      "organization_audit_action_check",
      sql.raw(`action in (${sqlList(AUDIT_ACTIONS)})`),
    ),
    check(
      "organization_audit_role_check",
      sql.raw(
        `(role is null or role in (${sqlList(AUDIT_ROLES)})) and (previous_role is null or previous_role in (${sqlList(AUDIT_ROLES)}))`,
      ),
    ),
  ],
);
