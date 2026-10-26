import { and, count, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { recordAudit } from "@/modules/admin/audit";
import type { ActorKind } from "@/modules/admin/constants";
import type { StaffRole } from "./roles";
import { isStaffRole } from "./roles";
import { session, user, userRole } from "./schema";

/** Staff roles held by a user; empty for regular users. */
export async function listRoles(
  db: NodePgDatabase,
  userId: string,
): Promise<StaffRole[]> {
  const rows = await db
    .select({ role: userRole.role })
    .from(userRole)
    .where(eq(userRole.userId, userId));
  // The CHECK constraint guarantees valid values; filter defensively anyway.
  return rows.map((row) => row.role).filter(isStaffRole);
}

export async function findUserByEmail(db: NodePgDatabase, email: string) {
  const rows = await db
    .select({ id: user.id, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.email, email.trim().toLowerCase()))
    .limit(1);
  return rows[0] ?? null;
}

export type RoleChangeResult =
  | { status: "granted" | "revoked"; userId: string; sessionsRevoked: number }
  | { status: "unchanged"; userId: string }
  | {
      status:
        | "user_not_found"
        | "email_not_verified"
        | "invalid_role"
        | "self_change"
        | "last_super_admin"
        | "actor_not_super_admin";
    };

/**
 * Grants or revokes a staff role and, when something changed, deletes all the
 * user's sessions and writes an admin audit row in the same transaction, so
 * the next session is a fresh sign-in (session rotation on privilege change,
 * ADR-002) and the change is on record (ADR-008).
 *
 * Changes are serialized (advisory lock), so the "at least one super admin"
 * rule cannot be raced. The rule and the ban on changing one's own roles
 * apply to staff in the app; the operator command line may bootstrap or
 * repair (actor kind `operator`).
 */
export async function changeRole(
  db: NodePgDatabase,
  input: {
    email: string;
    role: string;
    change: "grant" | "revoke";
    grantedBy?: string | null;
    /** Who made the change, for the audit log. Default: the operator CLI. */
    actor?: { id: string | null; kind: ActorKind; ip?: string | null };
  },
): Promise<RoleChangeResult> {
  const actor = input.actor ?? {
    id: input.grantedBy ?? null,
    kind: "operator" as const,
  };
  if (!isStaffRole(input.role)) return { status: "invalid_role" };
  const role = input.role;
  const target = await findUserByEmail(db, input.email);
  if (!target) return { status: "user_not_found" };
  if (!target.emailVerified) return { status: "email_not_verified" };

  if (actor.kind === "staff" && actor.id === target.id)
    return { status: "self_change" };

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('identity:roles', 0))`,
    );
    // The acting super admin may have been revoked since their session was
    // read; check again under the lock.
    if (actor.kind === "staff") {
      const still = actor.id
        ? await tx
            .select({ id: userRole.id })
            .from(userRole)
            .where(
              and(
                eq(userRole.userId, actor.id),
                eq(userRole.role, "super_admin"),
              ),
            )
            .limit(1)
        : [];
      if (still.length === 0)
        return { status: "actor_not_super_admin" as const };
    }
    if (
      actor.kind === "staff" &&
      input.change === "revoke" &&
      role === "super_admin"
    ) {
      const [admins] = await tx
        .select({ n: count() })
        .from(userRole)
        .where(eq(userRole.role, "super_admin"));
      if ((admins?.n ?? 0) <= 1) return { status: "last_super_admin" as const };
    }
    const changed =
      input.change === "grant"
        ? await tx
            .insert(userRole)
            .values({
              userId: target.id,
              role,
              grantedBy: input.grantedBy ?? actor.id,
            })
            .onConflictDoNothing({ target: [userRole.userId, userRole.role] })
            .returning({ id: userRole.id })
        : await tx
            .delete(userRole)
            .where(and(eq(userRole.userId, target.id), eq(userRole.role, role)))
            .returning({ id: userRole.id });
    if (changed.length === 0) {
      return { status: "unchanged" as const, userId: target.id };
    }
    const revoked = await tx
      .delete(session)
      .where(eq(session.userId, target.id))
      .returning({ id: session.id });
    await recordAudit(tx, {
      actorId: actor.id,
      actorKind: actor.kind,
      action: input.change === "grant" ? "role.granted" : "role.revoked",
      targetType: "user",
      targetId: target.id,
      detail: { role },
      ip: actor.ip ?? null,
    });
    return {
      status:
        input.change === "grant" ? ("granted" as const) : ("revoked" as const),
      userId: target.id,
      sessionsRevoked: revoked.length,
    };
  });
}

export type StaffAccount = {
  userId: string;
  email: string;
  roles: { role: StaffRole; grantedAt: string; grantedBy: string | null }[];
};

/** Every account holding a staff role, for the role management page. */
export async function listStaffAccounts(
  db: NodePgDatabase,
): Promise<StaffAccount[]> {
  const rows = await db
    .select({
      userId: userRole.userId,
      email: user.email,
      role: userRole.role,
      grantedAt: userRole.grantedAt,
      grantedBy: userRole.grantedBy,
    })
    .from(userRole)
    .innerJoin(user, eq(user.id, userRole.userId))
    .orderBy(user.email, userRole.role);
  const byUser = new Map<string, StaffAccount>();
  for (const r of rows) {
    if (!isStaffRole(r.role)) continue;
    const entry = byUser.get(r.userId) ?? {
      userId: r.userId,
      email: r.email,
      roles: [],
    };
    entry.roles.push({
      role: r.role,
      grantedAt: r.grantedAt.toISOString(),
      grantedBy: r.grantedBy,
    });
    byUser.set(r.userId, entry);
  }
  return [...byUser.values()];
}
