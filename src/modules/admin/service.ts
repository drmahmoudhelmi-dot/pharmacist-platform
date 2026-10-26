import "server-only";
import { and, desc, eq, lt, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { getEmailsOfUsers } from "@/modules/identity/contact";
import { type Actor, can } from "@/modules/identity/policy";
import { isStaffRole } from "@/modules/identity/roles";
import {
  changeRole,
  findUserByEmail,
  listStaffAccounts,
  type StaffAccount,
} from "@/modules/identity/roles-service";
import {
  ACTOR_KINDS,
  AUDIT_PAGE_SIZE,
  type ActorKind,
  type AuditAction,
  isAuditAction,
  isTargetType,
  type TargetType,
} from "./constants";
import { adminAudit } from "./schema";

// Admin services for staff (ADR-008): role management for super admins and
// the audit viewer. Authorization through identity's policy: `roles.manage`
// and `audit.read` (role super_admin, verified email, TOTP session).

type Db = NodePgDatabase;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string =>
  typeof v === "string" && UUID.test(v);

// ---------------------------------------------------------------------------
// Roles

export type StaffAccountView = Omit<StaffAccount, "roles"> & {
  roles: (StaffAccount["roles"][number] & { grantedByEmail: string | null })[];
  isSelf: boolean;
};

/** Staff accounts for super admins; empty for anyone else. */
export async function listStaff(
  db: Db,
  actor: Actor,
): Promise<StaffAccountView[]> {
  if (!can(actor, "roles.manage")) return [];
  const accounts = await listStaffAccounts(db);
  const granters = await getEmailsOfUsers(db, [
    ...new Set(
      accounts.flatMap((a) => a.roles.map((r) => r.grantedBy).filter(isUuid)),
    ),
  ]);
  return accounts.map((a) => ({
    ...a,
    isSelf: a.userId === actor.userId,
    roles: a.roles.map((r) => ({
      ...r,
      grantedByEmail: r.grantedBy ? (granters.get(r.grantedBy) ?? null) : null,
    })),
  }));
}

export type RoleActionError =
  | "forbidden"
  | "validation"
  | "userNotFound"
  | "emailNotVerified"
  | "selfChange"
  | "lastSuperAdmin";

export type RoleActionResult =
  | { ok: true; status: "granted" | "revoked" | "unchanged" }
  | { ok: false; error: RoleActionError };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * A super admin grants or revokes a staff role (by the account's email).
 * Never on their own account; at least one super admin always remains; the
 * target's sessions are revoked and the change is audited (identity's
 * changeRole, one transaction).
 */
export async function changeStaffRole(
  db: Db,
  actor: Actor,
  input: { email: unknown; role: unknown; change: "grant" | "revoke" },
  ip: string | null = null,
): Promise<RoleActionResult> {
  if (!can(actor, "roles.manage")) return { ok: false, error: "forbidden" };
  const email =
    typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > 254 || !isStaffRole(input.role))
    return { ok: false, error: "validation" };
  const result = await changeRole(db, {
    email,
    role: input.role,
    change: input.change,
    actor: { id: actor.userId, kind: "staff", ip },
  });
  switch (result.status) {
    case "granted":
    case "revoked":
    case "unchanged":
      return { ok: true, status: result.status };
    case "user_not_found":
      return { ok: false, error: "userNotFound" };
    case "email_not_verified":
      return { ok: false, error: "emailNotVerified" };
    case "self_change":
      return { ok: false, error: "selfChange" };
    case "last_super_admin":
      return { ok: false, error: "lastSuperAdmin" };
    case "actor_not_super_admin":
      return { ok: false, error: "forbidden" };
    case "invalid_role":
      return { ok: false, error: "validation" };
  }
}

// ---------------------------------------------------------------------------
// Audit viewer

export type AuditEntryView = {
  id: string;
  at: string;
  actorKind: ActorKind;
  /** The actor's email (staff and members); null for operator and system. */
  actorEmail: string | null;
  action: AuditAction;
  targetType: TargetType;
  targetId: string;
  detail: Record<string, string>;
  ip: string | null;
};

export type AuditPage = { items: AuditEntryView[]; nextCursor: string | null };

export type AuditFilter = {
  action?: string;
  targetType?: string;
  targetId?: string;
  actorEmail?: string;
  cursor?: string;
};

function encodeCursor(at: Date, id: string) {
  return Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
}

function decodeCursor(cursor: unknown) {
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(cursor))
    return null;
  const [iso, id] = Buffer.from(cursor, "base64url").toString().split("|");
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime()) || !isUuid(id)) return null;
  return { at, id };
}

/**
 * The audit log for super admins, newest first, keyset pages of 50. Filters
 * are lenient: an invalid one is ignored. Empty for anyone else.
 */
export async function searchAudit(
  db: Db,
  actor: Actor,
  filter: AuditFilter = {},
): Promise<AuditPage> {
  const empty: AuditPage = { items: [], nextCursor: null };
  if (!can(actor, "audit.read")) return empty;
  let actorId: string | null | undefined;
  if (filter.actorEmail?.trim()) {
    const found = await findUserByEmail(db, filter.actorEmail);
    if (!found) return empty;
    actorId = found.id;
  }
  const before = decodeCursor(filter.cursor);
  const rows = await db
    .select()
    .from(adminAudit)
    .where(
      and(
        isAuditAction(filter.action)
          ? eq(adminAudit.action, filter.action)
          : undefined,
        isTargetType(filter.targetType)
          ? eq(adminAudit.targetType, filter.targetType)
          : undefined,
        isUuid(filter.targetId)
          ? eq(adminAudit.targetId, filter.targetId)
          : undefined,
        actorId ? eq(adminAudit.actorId, actorId) : undefined,
        before
          ? or(
              lt(adminAudit.at, before.at),
              and(eq(adminAudit.at, before.at), lt(adminAudit.id, before.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(adminAudit.at), desc(adminAudit.id))
    .limit(AUDIT_PAGE_SIZE + 1);
  const page = rows.slice(0, AUDIT_PAGE_SIZE);
  const emails = await getEmailsOfUsers(db, [
    ...new Set(page.map((r) => r.actorId).filter(isUuid)),
  ]);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actorKind: (ACTOR_KINDS as readonly string[]).includes(r.actorKind)
        ? (r.actorKind as ActorKind)
        : "system",
      actorEmail: r.actorId ? (emails.get(r.actorId) ?? null) : null,
      action: r.action as AuditAction,
      targetType: r.targetType as TargetType,
      targetId: r.targetId,
      detail: r.detail,
      ip: r.ip,
    })),
    nextCursor:
      rows.length > AUDIT_PAGE_SIZE && last
        ? encodeCursor(last.at, last.id)
        : null,
  };
}
