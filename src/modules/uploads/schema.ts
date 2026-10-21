import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "@/modules/identity/schema";
import {
  ACCEPTED_TYPES,
  OUTPUT_TYPE,
  REJECT_REASONS,
  UPLOAD_LIMITS,
  UPLOAD_PURPOSES,
  UPLOAD_STATUSES,
} from "./constants";

// The table owned by the uploads module (ADR-004, 4a). One row per file a user
// posted. Object keys are random and never leave the server; clients see the
// row id and status only. The foreign key to `user` is the only reference to
// identity's tables.

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

const sqlList = (values: readonly string[]) =>
  values.map((v) => `'${v}'`).join(", ");

export const upload = pgTable(
  "upload",
  {
    id: uuid("id")
      .default(sql`gen_random_uuid()`)
      .primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    purpose: text("purpose", { enum: UPLOAD_PURPOSES }).notNull(),
    status: text("status", { enum: UPLOAD_STATUSES })
      .default("processing")
      .notNull(),
    rejectReason: text("reject_reason", { enum: REJECT_REASONS }),
    // `quarantine/<uuid>`: where the raw upload waits for the worker. Kept after
    // processing as the record of where it was; the object itself is deleted.
    quarantineKey: text("quarantine_key").notNull().unique(),
    // `documents/<uuid>.jpg`: the scanned, re-encoded file. Set only when clean.
    objectKey: text("object_key").unique(),
    // Detected type and size of the upload while processing; of the stored
    // JPEG once clean.
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    // Hex SHA-256 of the stored JPEG. Set only when clean.
    sha256: text("sha256"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("upload_user_id_status_idx").on(table.userId, table.status),
    check(
      "upload_purpose_check",
      sql.raw(`${table.purpose.name} in (${sqlList(UPLOAD_PURPOSES)})`),
    ),
    check(
      "upload_status_check",
      sql.raw(`${table.status.name} in (${sqlList(UPLOAD_STATUSES)})`),
    ),
    check(
      "upload_reject_reason_check",
      sql.raw(`${table.rejectReason.name} in (${sqlList(REJECT_REASONS)})`),
    ),
    check(
      "upload_content_type_check",
      sql.raw(
        `${table.contentType.name} in (${sqlList([...new Set([...ACCEPTED_TYPES, OUTPUT_TYPE])])})`,
      ),
    ),
    check(
      "upload_byte_size_check",
      sql.raw(`${table.byteSize.name} between 1 and ${UPLOAD_LIMITS.maxBytes}`),
    ),
    check("upload_sha256_check", sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "upload_quarantine_key_check",
      sql`${table.quarantineKey} ~ '^quarantine/[0-9a-f-]{36}$'`,
    ),
    check(
      "upload_object_key_check",
      sql`${table.objectKey} ~ '^documents/[0-9a-f-]{36}\\.jpg$'`,
    ),
    // State and its fields move together: a clean row has its object and
    // hash, a rejected row has a reason and no object, a processing row neither.
    check(
      "upload_state_check",
      sql`(${table.status} = 'processing' and ${table.objectKey} is null and ${table.sha256} is null and ${table.rejectReason} is null)
       or (${table.status} = 'clean' and ${table.objectKey} is not null and ${table.sha256} is not null and ${table.rejectReason} is null)
       or (${table.status} = 'rejected' and ${table.objectKey} is null and ${table.sha256} is null and ${table.rejectReason} is not null)`,
    ),
  ],
);
