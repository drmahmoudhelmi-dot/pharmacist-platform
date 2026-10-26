import { sql } from "drizzle-orm";
import {
  check,
  index,
  inet,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "@/modules/identity/schema";
import { ACTOR_KINDS, AUDIT_ACTIONS, TARGET_TYPES } from "./constants";

// The admin audit log (ADR-008). Append-only: the trigger from migration 0004
// is attached in migration 0010. Targets are referenced by id only (no
// foreign key), so the record outlives them.

const sqlList = (values: readonly string[]) =>
  values.map((v) => `'${v}'`).join(", ");

export const adminAudit = pgTable(
  "admin_audit",
  {
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    at: timestamp("at", { withTimezone: true, mode: "date", precision: 3 })
      .defaultNow()
      .notNull(),
    // The only column a cascaded update may change (to NULL).
    actorId: uuid("actor_id").references(() => user.id, {
      onDelete: "set null",
    }),
    actorKind: text("actor_kind", { enum: ACTOR_KINDS }).notNull(),
    action: text("action", { enum: AUDIT_ACTIONS }).notNull(),
    targetType: text("target_type", { enum: TARGET_TYPES }).notNull(),
    targetId: uuid("target_id").notNull(),
    // Codes and ids only, validated per action (audit.ts).
    detail: jsonb("detail").$type<Record<string, string>>().notNull(),
    ip: inet("ip"),
  },
  (table) => [
    index("admin_audit_at_idx").on(table.at, table.id),
    index("admin_audit_target_idx").on(table.targetType, table.targetId),
    index("admin_audit_actor_idx").on(table.actorId, table.at),
    check(
      "admin_audit_action_check",
      sql.raw(`action in (${sqlList(AUDIT_ACTIONS)})`),
    ),
    check(
      "admin_audit_actor_kind_check",
      sql.raw(`actor_kind in (${sqlList(ACTOR_KINDS)})`),
    ),
    check(
      "admin_audit_target_type_check",
      sql.raw(`target_type in (${sqlList(TARGET_TYPES)})`),
    ),
    check(
      "admin_audit_detail_check",
      sql.raw(`jsonb_typeof(detail) = 'object'`),
    ),
  ],
);
