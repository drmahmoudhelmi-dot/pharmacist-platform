import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { recordAudit } from "@/modules/admin/audit";
import { enqueue, type PgBoss } from "@/shared/jobs/boss";
import { getEmailsOfUsers } from "./contact";
import { type Actor, can } from "./policy";
import { isStaffRole, type StaffRole } from "./roles";
import { accountSuspension, session, user, userRole } from "./schema";
import { isSuspended } from "./suspension-state";
import {
  isLiftReason,
  isSuspensionReason,
  type LiftReason,
  SUSPENSION_LIMITS,
  type SuspensionReason,
} from "./suspension-constants";

// Account suspension (ADR-009). A suspended account has no sessions and gets
// no new ones (Better Auth's session-create hook in auth-config.ts calls
// `isSuspended`). Moderators and super admins act through `account.suspend`;
// an account holding any staff role is suspended or reinstated by a super
// admin only, and nobody acts on their own account. Every change writes an
// admin audit row and queues the account's email in the same transaction.

type Db = NodePgDatabase;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type SuspensionDeps = { db: Db; boss: PgBoss; now?: () => Date };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string =>
  typeof v === "string" && UUID.test(v);

export { getSuspendedUserIds, isSuspended } from "./suspension-state";

// ---------------------------------------------------------------------------
// Staff view

export type SuspensionRecord = {
  id: string;
  reasonCode: SuspensionReason;
  /** Internal note; staff only. */
  note: string | null;
  suspendedAt: string;
  suspendedByEmail: string | null;
  liftedAt: string | null;
  liftReasonCode: LiftReason | null;
  liftedByEmail: string | null;
};

export type StaffAccountLookup = {
  userId: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
  roles: StaffRole[];
  suspended: boolean;
  isSelf: boolean;
  /** Whether this actor may suspend or reinstate the account. */
  canAct: boolean;
  history: SuspensionRecord[];
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * One account by its exact email, with its suspension history, for staff
 * with `account.suspend`. Null for anyone else and for unknown addresses.
 */
export async function findAccountForStaff(
  db: Db,
  actor: Actor,
  rawEmail: unknown,
): Promise<StaffAccountLookup | null> {
  if (!can(actor, "account.suspend")) return null;
  const email =
    typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > 254) return null;
  const [found] = await db
    .select({
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
    })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (!found) return null;
  const [roleRows, rows] = await Promise.all([
    db
      .select({ role: userRole.role })
      .from(userRole)
      .where(eq(userRole.userId, found.id)),
    db
      .select()
      .from(accountSuspension)
      .where(eq(accountSuspension.userId, found.id))
      .orderBy(desc(accountSuspension.suspendedAt)),
  ]);
  const roles = roleRows.map((r) => r.role).filter(isStaffRole);
  const staff = await getEmailsOfUsers(db, [
    ...new Set(rows.flatMap((r) => [r.suspendedBy, r.liftedBy]).filter(isUuid)),
  ]);
  const isSelf = found.id === actor.userId;
  return {
    userId: found.id,
    email: found.email,
    emailVerified: found.emailVerified,
    createdAt: found.createdAt.toISOString(),
    roles,
    suspended: rows.some((r) => r.liftedAt === null),
    isSelf,
    canAct:
      !isSelf && (roles.length === 0 || actor.roles.includes("super_admin")),
    history: rows.map((r) => ({
      id: r.id,
      reasonCode: r.reasonCode,
      note: r.note,
      suspendedAt: r.suspendedAt.toISOString(),
      suspendedByEmail: r.suspendedBy
        ? (staff.get(r.suspendedBy) ?? null)
        : null,
      liftedAt: r.liftedAt?.toISOString() ?? null,
      liftReasonCode: r.liftReasonCode,
      liftedByEmail: r.liftedBy ? (staff.get(r.liftedBy) ?? null) : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Suspend and reinstate

export type SuspensionError =
  | "forbidden"
  | "validation"
  | "notFound"
  | "self"
  | "staffTarget"
  | "alreadySuspended"
  | "notSuspended";

export type SuspensionResult =
  { ok: true } | { ok: false; error: SuspensionError };

const fail = (error: SuspensionError): SuspensionResult => ({
  ok: false,
  error,
});

/**
 * Locks the target account and checks, under the lock, that the actor still
 * holds a role for `account.suspend` (their session may predate a revocation)
 * and may act on this target.
 */
async function lockTarget(
  tx: Tx,
  actor: Actor,
  userId: string,
): Promise<SuspensionError | null> {
  const [target] = await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, userId))
    .for("update");
  if (!target) return "notFound";
  if (userId === actor.userId) return "self";
  const roleRows = await tx
    .select({ userId: userRole.userId, role: userRole.role })
    .from(userRole)
    .where(inArray(userRole.userId, [actor.userId, userId]));
  const actorRoles = roleRows
    .filter((r) => r.userId === actor.userId)
    .map((r) => r.role);
  if (!actorRoles.some((r) => r === "moderator" || r === "super_admin"))
    return "forbidden";
  const targetIsStaff = roleRows.some((r) => r.userId === userId);
  if (targetIsStaff && !actorRoles.includes("super_admin"))
    return "staffTarget";
  return null;
}

function readNote(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return undefined;
  const note = raw.trim();
  if (note === "") return null;
  return note.length <= SUSPENSION_LIMITS.note.max ? note : undefined;
}

/**
 * Suspends an account: deletes its sessions, records the suspension, audits
 * it and emails the account (reason only, never the note).
 */
export async function suspendAccount(
  deps: SuspensionDeps,
  actor: Actor,
  input: { userId: unknown; reasonCode: unknown; note?: unknown },
  ip: string | null = null,
): Promise<SuspensionResult> {
  if (!can(actor, "account.suspend")) return fail("forbidden");
  if (!isUuid(input.userId)) return fail("notFound");
  const note = readNote(input.note);
  if (!isSuspensionReason(input.reasonCode) || note === undefined)
    return fail("validation");
  const userId = input.userId;
  const reasonCode = input.reasonCode;
  const now = deps.now?.() ?? new Date();
  return deps.db.transaction(async (tx) => {
    const refused = await lockTarget(tx, actor, userId);
    if (refused) return fail(refused);
    if (await isSuspended(tx, userId)) return fail("alreadySuspended");
    const [row] = await tx
      .insert(accountSuspension)
      .values({
        userId,
        reasonCode,
        note,
        suspendedBy: actor.userId,
        suspendedAt: now,
      })
      .returning({ id: accountSuspension.id });
    await tx.delete(session).where(eq(session.userId, userId));
    await recordAudit(tx, {
      actorId: actor.userId,
      actorKind: "staff",
      action: "account.suspended",
      targetType: "user",
      targetId: userId,
      detail: { reasonCode },
      ip,
    });
    await enqueue(
      deps.boss,
      "account.notify",
      { suspensionId: row!.id, kind: "suspended" },
      { tx },
    );
    return { ok: true as const };
  });
}

/** Lifts the active suspension of an account, audits it and emails it. */
export async function reinstateAccount(
  deps: SuspensionDeps,
  actor: Actor,
  input: { userId: unknown; reasonCode: unknown },
  ip: string | null = null,
): Promise<SuspensionResult> {
  if (!can(actor, "account.suspend")) return fail("forbidden");
  if (!isUuid(input.userId)) return fail("notFound");
  if (!isLiftReason(input.reasonCode)) return fail("validation");
  const userId = input.userId;
  const reasonCode = input.reasonCode;
  const now = deps.now?.() ?? new Date();
  return deps.db.transaction(async (tx) => {
    const refused = await lockTarget(tx, actor, userId);
    if (refused) return fail(refused);
    const lifted = await tx
      .update(accountSuspension)
      .set({
        liftedAt: now,
        liftedBy: actor.userId,
        liftReasonCode: reasonCode,
      })
      .where(
        and(
          eq(accountSuspension.userId, userId),
          isNull(accountSuspension.liftedAt),
        ),
      )
      .returning({ id: accountSuspension.id });
    const row = lifted[0];
    if (!row) return fail("notSuspended");
    await recordAudit(tx, {
      actorId: actor.userId,
      actorKind: "staff",
      action: "account.reinstated",
      targetType: "user",
      targetId: userId,
      detail: { reasonCode },
      ip,
    });
    await enqueue(
      deps.boss,
      "account.notify",
      { suspensionId: row.id, kind: "reinstated" },
      { tx },
    );
    return { ok: true as const };
  });
}
